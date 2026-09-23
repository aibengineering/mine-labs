import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Scenario } from "../scenario/schema.js";
import { type RunResult } from "../trial/run.js";
import { describeGoal } from "../trial/goals.js";
import { retainNewestRuns } from "../report/artifacts.js";
import { delay } from "../util/fs.js";
import { slugify } from "../util/text.js";
import { SessionController } from "./controller.js";
import { createSessionWorker } from "./worker.js";
import { createClientSessionWorker } from "./client-worker.js";
import { inspectScenario, type ScenarioInspection } from "../scenario/inspection.js";
import type { GoalResult } from "../trial/goals.js";

export interface SessionScenario {
  scenario: Scenario;
  /** Stable catalog identity; the scenario name sent to the client remains unchanged. */
  id?: string;
  category?: string;
}

export interface ScenarioSummary {
  name: string;
  category: string;
  inspection?: ScenarioInspection;
}

export interface SessionOptions {
  scenarios: SessionScenario[];
  rootDir: string;
  spectator?: { username: string };
  /** Force fresh worlds for isolation comparisons. Safe resets are otherwise automatic. */
  isolated?: boolean;
  /** Client sessions can change concurrency up to this limit while idle. */
  maxJobs?: number;
  /** Maximum isolated trials in flight. Each worker owns its own server. */
  jobs?: number;
  preferPort?: number;
  cycles?: number;
  delayMs?: number;
  keepRuns?: number;
  log: (message: string) => void;
  signal?: AbortSignal;
  controller?: SessionController;
  observer?: SessionObserver;
  onResult?: (result: RunResult, context: TrialContext) => void | Promise<void>;
}

export interface TrialContext {
  trialId: string;
  sequence: number;
  workerIndex: number;
  cycle: number;
  scenarioIndex: number;
  scenarioCount: number;
  scenario: string;
  goalText: string;
  inspection?: ScenarioInspection;
  runDir: string;
  startedAt: string;
}

export interface SessionObserver {
  onGoalProgress?: (context: TrialContext, goal: GoalResult) => void;
  onMenu?: () => void;
  onPreparation?: (message: string) => void;
  onConnectionChanged?: (connection: SpectatorConnection | null) => void;
  onTrialRunning?: (context: TrialContext) => void | Promise<void>;
  onSessionStart?: (context: { scenarios: ScenarioSummary[]; spectator?: { username: string }; jobs: number }) => void | Promise<void>;
  onTrialStart?: (context: TrialContext) => void | Promise<void>;
  onTrialResult?: (result: RunResult, context: TrialContext) => void | Promise<void>;
  onSessionStop?: (summary: SessionSummary) => void | Promise<void>;
}

export interface SpectatorConnection {
  id: string;
  host: "127.0.0.1";
  port: number;
  /** First declared scenario player; also the default spectator viewpoint. */
  focusPlayer?: string;
}

export interface SessionSummary {
  runs: number;
  passed: number;
  failed: number;
  cancelled: number;
}

/** Cycle scenarios until the requested bound or abort signal is reached. */
export async function runSession(options: SessionOptions): Promise<SessionSummary> {
  if (options.scenarios.length === 0) throw new Error("session requires at least one scenario");
  if (options.scenarios.some(({ scenario }) => scenario.verification && !Array.isArray(scenario.players[0]?.pos))) {
    throw new Error("Expand verification locations with loadRunCatalog before running a session");
  }
  const cycles = options.cycles ?? Number.POSITIVE_INFINITY;
  if (!Number.isInteger(cycles) && cycles !== Number.POSITIVE_INFINITY) throw new Error("cycles must be an integer or Infinity");
  if (cycles < 1) throw new Error("cycles must be positive");
  const keepRuns = options.keepRuns ?? 100;
  if (!Number.isInteger(keepRuns) || keepRuns < 0) throw new Error("keepRuns must be a nonnegative integer");
  const jobs = options.jobs ?? 1;
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error("jobs must be a positive integer");
  options.controller?.setJobs(jobs);
  if (options.maxJobs !== undefined && (!Number.isInteger(options.maxJobs) || options.maxJobs < jobs)) throw new Error("maxJobs must be an integer at least jobs");
  await mkdir(join(options.rootDir, "runs"), { recursive: true });

  const summary: SessionSummary = {
    runs: 0,
    passed: 0,
    failed: 0,
    cancelled: 0,
  };
  await options.observer?.onSessionStart?.({
    scenarios: options.scenarios.map(({ scenario, category, id }) => ({
      name: id ?? scenario.name ?? "scenario",
      category: category ?? "other",
      inspection: inspectScenario(id ?? scenario.name ?? "scenario", scenario),
    })),
    spectator: options.spectator,
    jobs,
  });
  const serverRoot = join(options.rootDir, "servers", randomUUID());
  const scheduler = new TrialScheduler(options, cycles);
  const clientWorker = options.spectator
    ? createClientSessionWorker(options, serverRoot, () => scheduler.peek()) : undefined;
  const workers = Array.from({ length: options.maxJobs ?? jobs }, (_, index) =>
    index === 0 && clientWorker ? clientWorker : createSessionWorker(options, index, serverRoot));
  const unsubscribe = options.controller?.onScheduleChange(() => clientWorker?.refresh());
  const cancel = (): void => options.controller?.stop();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const close = async (): Promise<void> => {
    const outcomes = await Promise.allSettled(workers.map(worker => worker.close()));
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(failure => failure.reason), "Session servers failed to close");
  };
  try {
    await runScheduledWorkers(options, scheduler, keepRuns, summary, workers.length,
      (entry, context, signal) => workers[context.workerIndex]!.runTrial(entry, context, signal), close,
      () => clientWorker?.refresh());
  } finally {
    unsubscribe?.();
    options.signal?.removeEventListener("abort", cancel);
    try { await close(); } finally { await options.observer?.onSessionStop?.(summary); }
  }
  return summary;
}

type TrialExecutor = (entry: SessionScenario, context: TrialContext, signal: AbortSignal | undefined) => Promise<RunResult>;

type TrialClaim =
  | { kind: "trial"; entry: SessionScenario; context: TrialContext }
  | { kind: "menu" }
  | { kind: "wait" }
  | { kind: "complete" };

/** Central, synchronous claimant: workers cannot consume the same schedule slot. */
export class TrialScheduler {
  #cycle = 1;
  #scenarioIndex = 0;
  #sequence = 0;
  readonly #lastClaimed = new Map<number, string | undefined>();

  constructor(private readonly options: SessionOptions, private readonly cycles: number) {}

  /** Predict the next claim without advancing cycles or consuming UI requests. */
  peek(): SessionScenario | undefined {
    if (runStopped(this.options) || this.#cycle > this.cycles) return undefined;
    const controller = this.options.controller;
    const pending = controller?.pendingSchedule;
    if (pending?.menu) return undefined;
    const schedule = controller?.selectedCategory
      ? this.options.scenarios.filter(entry => (entry.category ?? "other") === controller.selectedCategory)
      : this.options.scenarios;
    if (!schedule.length) return undefined;
    if (controller && !controller.canRepeat && !pending?.requested && !pending?.changed && !pending?.batch) return undefined;
    const repeat = controller?.canRepeat && controller.singleScenarioEnabled && !pending?.changed
      ? this.#lastClaimed.get(0) : undefined;
    const selected = pending?.requested ?? repeat;
    if (selected) {
      const requested = this.options.scenarios.find(entry => (entry.id ?? entry.scenario.name) === selected);
      if (requested) return requested;
    }
    return schedule[pending?.changed || this.#scenarioIndex >= schedule.length ? 0 : this.#scenarioIndex];
  }

  claim(workerIndex: number): TrialClaim {
    if (runStopped(this.options) || this.#cycle > this.cycles) return { kind: "complete" };
    if (this.options.controller?.takeMenuRequest()) {
      this.#lastClaimed.clear();
      return { kind: "menu" };
    }

    const scheduleChanged = this.options.controller?.takeScheduleChange() ?? false;
    if (scheduleChanged) { this.#scenarioIndex = 0; this.#lastClaimed.clear(); }
    // The suite cursor already points past the running trial. Pin the actual
    // worker selection when single-test repetition is enabled mid-flight.
    const requested = this.options.controller?.takeRequestedScenario() ??
      (this.options.controller?.canRepeat && this.options.controller.singleScenarioEnabled
        ? this.#lastClaimed.get(workerIndex) : undefined);
    const selectedCategory = this.options.controller?.selectedCategory;
    const schedule = selectedCategory
      ? this.options.scenarios.filter((entry) => (entry.category ?? "other") === selectedCategory)
      : this.options.scenarios;
    if (schedule.length === 0) throw new Error(`no scenarios found in category '${selectedCategory}'`);
    if (scheduleChanged) this.options.controller?.queueBatch(schedule.length);
    const batch = this.options.controller?.takeBatchPermit();
    if (this.options.controller && !this.options.controller.canRepeat && !requested && !batch) return { kind: "wait" };
    if (this.#scenarioIndex >= schedule.length) this.#scenarioIndex = 0;

    let oneOff: SessionScenario | undefined;
    if (requested) {
      const selected = schedule.findIndex(({ scenario, id }) => (id ?? scenario.name) === requested);
      if (selected >= 0) this.#scenarioIndex = selected;
      else oneOff = this.options.scenarios.find(({ scenario, id }) => (id ?? scenario.name) === requested);
      if (!oneOff && selected < 0) this.options.log(`ignored unknown requested scenario '${requested}'`);
    }

    const entry = oneOff ?? schedule[this.#scenarioIndex]!;
    this.#lastClaimed.set(workerIndex, entry.id ?? entry.scenario.name);
    const sequence = ++this.#sequence;
    const cycle = this.#cycle;
    const scenarioIndex = oneOff ? 0 : this.#scenarioIndex;
    const context: TrialContext = {
      trialId: `trial-${sequence}`,
      sequence,
      workerIndex,
      cycle,
      scenarioIndex,
      scenarioCount: oneOff ? 1 : schedule.length,
      scenario: entry.id ?? entry.scenario.name ?? "scenario",
      goalText: describeGoal(entry.scenario.goal),
      inspection: inspectScenario(entry.id ?? entry.scenario.name ?? "scenario", entry.scenario),
      runDir: runDirectory(this.options.rootDir, { cycle, sequence, workerIndex, scenario: entry.scenario }),
      startedAt: new Date().toISOString(),
    };
    if (!oneOff) {
      ({ cycle: this.#cycle, scenarioIndex: this.#scenarioIndex } = advanceSchedule(
        this.#cycle,
        this.#scenarioIndex,
        schedule.length,
        Boolean(this.options.controller?.canRepeat && this.options.controller.singleScenarioEnabled),
      ));
    }
    return { kind: "trial", entry, context };
  }
}

async function runScheduledWorkers(
  options: SessionOptions,
  scheduler: TrialScheduler,
  keepRuns: number,
  summary: SessionSummary,
  jobs: number,
  execute: TrialExecutor,
  releaseWorld?: () => Promise<void>,
  scheduleClaimed?: () => void,
): Promise<void> {
  const failure = new AbortController();
  const activeRunDirectories = new Set<string>();
  let settlementTail = Promise.resolve();
  const settle = (context: TrialContext, result: RunResult): Promise<void> => {
    activeRunDirectories.delete(context.runDir);
    const settlement = settlementTail.then(() =>
      settleRun(options, context, result, keepRuns, summary, activeRunDirectories),
    );
    settlementTail = settlement.catch(() => undefined);
    return settlement;
  };
  const workers = Array.from({ length: jobs }, (_, workerIndex) =>
    runWorker(options, workerIndex, scheduler, failure.signal, execute, settle, activeRunDirectories, releaseWorld, scheduleClaimed),
  );
  try {
    await Promise.all(workers);
  } catch (error) {
    failure.abort("parallel worker failed");
    options.controller?.stop();
    await Promise.allSettled(workers);
    throw error;
  }
}

async function runWorker(
  options: SessionOptions,
  workerIndex: number,
  scheduler: TrialScheduler,
  failureSignal: AbortSignal,
  execute: TrialExecutor,
  settle: (context: TrialContext, result: RunResult) => Promise<void>,
  activeRunDirectories: Set<string>,
  releaseWorld?: () => Promise<void>,
  scheduleClaimed?: () => void,
): Promise<void> {
  while (!runStopped(options) && !failureSignal.aborted) {
    await options.controller?.waitUntilRunnable(workerIndex);
    if (runStopped(options) || failureSignal.aborted) return;
    const claim = scheduler.claim(workerIndex);
    if (claim.kind === "complete") return;
    if (claim.kind === "wait") continue;
    if (claim.kind === "menu") {
      await releaseWorld?.();
      options.observer?.onMenu?.();
      continue;
    }

    const { entry, context } = claim;
    activeRunDirectories.add(context.runDir);
    const controlledSignal = options.controller?.beginTrial(context.trialId);
    const signal = combineSignals(options.signal, options.controller?.signal, failureSignal, controlledSignal);
    let result: RunResult;
    let completed = false;
    try {
      await options.observer?.onTrialStart?.(context);
      const execution = execute(entry, context, signal);
      scheduleClaimed?.();
      result = await execution;
      completed = true;
    } finally {
      if (controlledSignal) options.controller?.finishTrial(context.trialId, controlledSignal);
      if (!completed) activeRunDirectories.delete(context.runDir);
    }
    await settle(context, result);
    if (!failureSignal.aborted && !runStopped(options)) {
      await delay(options.delayMs ?? 2000, combineSignals(options.signal, options.controller?.signal, failureSignal));
    }
  }
}

/** @internal Advance to the next scenario or repetition. */
export function advanceSchedule(cycle: number, scenarioIndex: number, scenarioCount: number, singleScenario: boolean): { cycle: number; scenarioIndex: number } {
  if (singleScenario) return { cycle: cycle + 1, scenarioIndex };
  const nextIndex = scenarioIndex + 1;
  return nextIndex === scenarioCount ? { cycle: cycle + 1, scenarioIndex: 0 } : { cycle, scenarioIndex: nextIndex };
}

async function settleRun(
  options: SessionOptions,
  context: TrialContext,
  result: RunResult,
  keepRuns: number,
  summary: SessionSummary,
  activeRunDirectories: ReadonlySet<string>,
): Promise<void> {
  summary.runs += 1;
  if (result.outcome === "pass") summary.passed += 1;
  else if (result.outcome === "cancelled") summary.cancelled += 1;
  else summary.failed += 1;
  await options.onResult?.(result, context);
  await options.observer?.onTrialResult?.(result, context);
  await retainNewestRuns(join(options.rootDir, "runs"), keepRuns, activeRunDirectories);
}

function runStopped(options: SessionOptions): boolean {
  return Boolean(options.signal?.aborted || options.controller?.signal.aborted);
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function runDirectory(rootDir: string, trial: { cycle: number; sequence: number; workerIndex: number; scenario: Scenario }): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const sequence = String(trial.sequence).padStart(5, "0");
  return join(rootDir, "runs", `${timestamp}-t${sequence}-w${trial.workerIndex + 1}-c${trial.cycle}-${slugify(trial.scenario.name ?? "scenario")}`);
}
