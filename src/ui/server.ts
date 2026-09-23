/**
 * A loopback HTTP API so a session can be watched and steered from in-game.
 *
 * Reading a terminal is not possible while you are inside Minecraft watching a
 * trial, which is exactly when you most want to know what is running and to say
 * "skip this one". This server exposes the session's live state as a snapshot
 * and accepts control commands, and the optional client mod in `client-mod/`
 * renders that as an in-game overlay.
 *
 * It also implements `SessionObserver`, so it learns about trials by
 * being notified rather than by polling anything.
 *
 * Two constraints shape it: it binds to 127.0.0.1 only, because it can stop
 * runs and must never be reachable off the machine; and statistics are restored
 * from retained `results.json` files at startup, so restarting the harness does
 * not blank the history an operator was reading.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionObserver, SessionSummary, ScenarioSummary, TrialContext, SpectatorConnection } from "../session/run.js";
import { SessionController } from "../session/controller.js";
import type { RunResult } from "../trial/run.js";
import type { ScenarioInspection } from "../scenario/inspection.js";
import type { GoalResult } from "../trial/goals.js";

export const DEFAULT_UI_PORT = 25_578;
const MAX_CONTROL_BODY_BYTES = 16_384;
const MAX_RECENT_RESULTS = 20;
// The client rejects status responses above 1,000,000 characters. Real retained
// diagnostics exceeded that by themselves. The recent-results panel needs only
// a preview: 20 x 1,000 characters leaves room for the catalog even after JSON
// escaping. Full evidence remains in results.json and on-demand run inspection.
const MAX_RESULT_PREVIEW_CHARS = 1_000;
const MAX_RECENT_OUTCOMES = 5;
const MAX_STATISTICS_RESULTS = 15;

export interface UiResult {
  scenario: string;
  outcome: RunResult["outcome"];
  elapsedMs: number;
  detail: string;
  finishedAt: string;
}

export interface UiScenarioStats {
  scenario: string;
  runs: number;
  passed: number;
  failed: number;
  cancelled: number;
  averageElapsedMs: number;
  recentOutcomes: RunResult["outcome"][];
}

export interface UiScenarioCategory {
  name: string;
  scenarios: string[];
}

export interface UiActiveTrial {
  trialId: string;
  workerIndex: number;
  scenario: string;
  goalText: string;
  cycle: number;
  scenarioIndex: number;
  scenarioCount: number;
  startedAt: string;
}

export interface UiSnapshot {
  jobs: number;
  maxJobs: number;
  apiVersion: 1;
  phase: "starting" | "preparing" | "ready" | "returning" | "waiting" | "paused" | "running" | "stopping" | "stopped";
  connection: SpectatorConnection | null;
  generatedAt: string;
  message: string;
  continuousEnabled: boolean;
  autoStartEnabled: boolean;
  awaitingStartTrialId: string | null;
  singleScenarioEnabled: boolean;
  selectedCategory: string | null;
  scenarios: string[];
  categories: UiScenarioCategory[];
  /** First active worker, retained for existing client-mod compatibility. */
  active: UiActiveTrial | null;
  activeTrials: UiActiveTrial[];
  totals: { runs: number; passed: number; failed: number; cancelled: number };
  scenarioStats: UiScenarioStats[];
  recent: UiResult[];
  currentScenario: string | null;
  scenarioTags: Record<string, string[]>;
}

interface ScenarioAccumulator {
  scenario: string;
  results: UiResult[];
}

export interface UiServerOptions {
  maxJobs?: number;
  controller: SessionController;
  rootDir: string;
  port?: number;
  log?: (message: string) => void;
  refreshCatalog?: () => Promise<ScenarioSummary[]>;
}

export class UiServer implements SessionObserver {
  readonly #controller: SessionController;
  readonly #maxJobs: number;
  readonly #rootDir: string;
  readonly #requestedPort: number;
  readonly #log: (message: string) => void;
  readonly #server: Server;
  #phase: UiSnapshot["phase"] = "starting";
  #message = "Mine Labs is starting";
  #scenarios: string[] = [];
  #categories: UiScenarioCategory[] = [];
  #activeTrials = new Map<string, UiActiveTrial>();
  #recent: UiResult[] = [];
  #statisticsWindow: UiResult[] = [];
  #scenarioStats = new Map<string, ScenarioAccumulator>();
  readonly #sockets = new Set<Socket>();
  #port = 0;
  #connection: SpectatorConnection | null = null;
  readonly #refreshCatalog: UiServerOptions["refreshCatalog"];
  #refreshing: Promise<ScenarioSummary[]> | undefined;
  #managed = false;
  #inspections = new Map<string, ScenarioInspection>();
  #current: { trialId: string; inspection: ScenarioInspection; progress?: GoalResult; outcome?: string } | undefined;

  constructor(options: UiServerOptions) {
    this.#controller = options.controller;
    this.#maxJobs = options.maxJobs ?? options.controller.jobs;
    this.#refreshCatalog = options.refreshCatalog;
    this.#rootDir = options.rootDir;
    this.#requestedPort = options.port ?? DEFAULT_UI_PORT;
    this.#log = options.log ?? (() => undefined);
    this.#server = createServer((request, response) => void this.#handle(request, response));
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
    });
  }

  get port(): number {
    return this.#port;
  }

  onPreparation(message: string): void {
    this.#setStatus(message, "preparing");
  }

  onTrialRunning(context: TrialContext): void {
    if (this.#managed && context.workerIndex !== 0) return;
    const active = this.#activeTrials.get(context.trialId);
    if (active) active.startedAt = new Date().toISOString();
    this.#setStatus(`Running ${context.scenario}`, "running");
  }

  onConnectionChanged(connection: SpectatorConnection | null): void {
    this.#connection = connection;
  }

  onMenu(): void {
    this.#setStatus("Choose a scenario to run", "paused");
  }

  onCatalogChanged(scenarios: ScenarioSummary[]): void {
    this.#inspections = new Map(scenarios.flatMap(entry => entry.inspection ? [[entry.name, entry.inspection] as const] : []));
    this.#scenarios = scenarios.map(({ name }) => name);
    this.#categories = groupCategories(scenarios);
    this.#controller.reconcileCatalog(this.#scenarios, this.#categories.map(({ name }) => name));
    for (const scenario of this.#scenarios) ensureScenario(this.#scenarioStats, scenario);
  }

  /**
   * The only place `#phase` and `#message` are assigned.
   *
   * They are one fact — what the session is doing right now — reported to every
   * poller, and they were previously set in eight places that each had to
   * remember to update both. Omitting `phase` keeps the current one, for the
   * changes that only reword the status.
   */
  #setStatus(message: string, phase: UiSnapshot["phase"] = this.#phase): void {
    this.#phase = phase;
    this.#message = message;
  }

  async start(): Promise<void> {
    const retained = await loadRetainedResults(this.#rootDir);
    this.#recent = retained.recent;
    this.#statisticsWindow = retained.statisticsWindow;
    this.#scenarioStats = retained.scenarioStats;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(this.#requestedPort, "127.0.0.1", () => {
        this.#server.off("error", onError);
        const address = this.#server.address();
        this.#port = typeof address === "object" && address ? address.port : this.#requestedPort;
        resolve();
      });
    });
    this.#log(`ui: client mod API listening on http://127.0.0.1:${this.#port}`);
  }

  async close(): Promise<void> {
    if (!this.#server.listening && this.#sockets.size === 0) return;
    try {
      this.#server.closeAllConnections?.();
    } catch {
      // closeAllConnections is best-effort across runtimes
    }
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    this.#sockets.clear();
    await new Promise<void>((resolve, reject) => {
      if (!this.#server.listening) return resolve();
      this.#server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  onSessionStart(context: { scenarios: ScenarioSummary[]; spectator?: { username: string }; jobs: number }): void {
    this.#managed = Boolean(context.spectator);
    this.onCatalogChanged(context.scenarios);
    if (!this.#controller.canRepeat) return this.#setStatus("Choose a scenario to run", "paused");
    this.#setStatus(
      `Waiting for up to ${context.jobs} trial${context.jobs === 1 ? "" : "s"}`,
      "waiting",
    );
  }

  onTrialStart(context: TrialContext): void {
    if (!this.#managed || context.workerIndex === 0) this.#current = context.inspection ? { trialId: context.trialId, inspection: context.inspection } : undefined;
    this.#activeTrials.set(context.trialId, {
      trialId: context.trialId,
      workerIndex: context.workerIndex,
      scenario: context.scenario,
      goalText: context.goalText,
      cycle: context.cycle,
      scenarioIndex: context.scenarioIndex,
      scenarioCount: context.scenarioCount,
      startedAt: context.startedAt,
    });
    if (!this.#managed || context.workerIndex === 0) {
      this.#setStatus(this.#managed ? `Preparing ${context.scenario}` : activeMessage(this.#activeTrials), this.#managed ? "preparing" : "running");
    }
  }

  onTrialResult(result: RunResult, context: TrialContext): void {
    if (this.#current?.trialId === context.trialId) {
      this.#current.progress = result.goal;
      this.#current.outcome = result.outcome;
    }
    const uiResult: UiResult = {
      scenario: result.scenario,
      outcome: result.outcome,
      elapsedMs: result.elapsedMs,
      detail: result.error ?? result.goal.detail,
      finishedAt: new Date().toISOString(),
    };
    this.#recent.unshift(uiResult);
    this.#recent = this.#recent.slice(0, MAX_RECENT_RESULTS);
    recordStatistics(this.#statisticsWindow, this.#scenarioStats, uiResult, true);
    this.#activeTrials.delete(context.trialId);
    if (this.#phase === "stopping" || this.#phase === "returning") return;
    if (this.#managed && context.workerIndex !== 0 && this.#phase === "preparing") return;
    if (this.#activeTrials.size > 0) return this.#setStatus(activeMessage(this.#activeTrials), "running");
    const outcome = `${result.scenario}: ${result.outcome}`;
    this.#setStatus(
      this.#controller.continuousEnabled ? outcome : `${outcome}; Keep running is off`,
      this.#controller.continuousEnabled ? "waiting" : "paused",
    );
  }

  onSessionStop(summary: SessionSummary): void {
    this.#activeTrials.clear();
    this.#setStatus(`Stopped after ${summary.runs} run${summary.runs === 1 ? "" : "s"}`, "stopped");
  }

  snapshot(): UiSnapshot {
    const activeTrials = orderedActiveTrials(this.#activeTrials);
    const awaitingStartTrialId = this.#controller.awaitingStartTrialId ?? null;
    return {
      apiVersion: 1,
      currentScenario: this.#current?.inspection.name ?? null,
      scenarioTags: Object.fromEntries([...this.#inspections].map(([name, inspection]) => [name, inspection.tags])),
      connection: this.#connection,
      phase: awaitingStartTrialId ? "ready" : this.#phase,
      generatedAt: new Date().toISOString(),
      message: awaitingStartTrialId ? "Ready to inspect; start the scenario when you are ready" : this.#message,
      autoStartEnabled: this.#controller.autoStartEnabled,
      awaitingStartTrialId,
      continuousEnabled: this.#controller.continuousEnabled,
      jobs: this.#controller.jobs,
      maxJobs: this.#maxJobs,
      singleScenarioEnabled: this.#controller.singleScenarioEnabled,
      selectedCategory: this.#controller.selectedCategory ?? null,
      scenarios: [...this.#scenarios],
      categories: this.#categories.map((category) => ({
        ...category,
        scenarios: [...category.scenarios],
      })),
      active: activeTrials[0] ?? null,
      activeTrials,
      totals: countResults(this.#statisticsWindow),
      scenarioStats: orderedScenarioStats(this.#scenarioStats, this.#scenarios),
      recent: this.#recent.map((result) => ({ ...result, detail: resultDetailPreview(result.detail) })),
    };
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/scenario") {
        if (url.searchParams.get("current") === "true") {
          return this.#current ? json(response, 200, { ...this.#current.inspection, progress: this.#current.progress, outcome: this.#current.outcome ?? "in progress", source: "Current run: original configuration" })
            : json(response, 404, { error: "No current scenario to inspect" });
        }
        const inspection = this.#inspections.get(url.searchParams.get("name") ?? "");
        return inspection ? json(response, 200, { ...inspection, source: "Catalog: last loaded configuration" })
          : json(response, 404, { error: "Scenario details are unavailable" });
      }
      if (request.method === "GET" && request.url === "/api/status") {
        return json(response, 200, this.snapshot());
      }
      if (request.method === "GET" && request.url === "/") {
        return json(response, 200, {
          service: "mine-labs-ui",
          status: "/api/status",
          control: "/api/control",
        });
      }
      if (request.method === "POST" && request.url === "/api/control") {
        if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) {
          return json(response, 415, {
            error: "content-type must be application/json",
          });
        }
        const command = await readControl(request);
        return await this.#control(command, response);
      }
      json(response, 404, { error: "not found" });
    } catch (error) {
      json(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Apply one operator command. Each case validates, tells the controller, and
   * says what the session is now doing; the accepted-response shape is shared
   * so a new action cannot accidentally answer in a different format.
   */
  async #control(command: ControlCommand, response: ServerResponse): Promise<void> {
    const accepted = (extra: Record<string, unknown> = {}): void =>
      json(response, 202, { accepted: true, action: command.action, ...extra });

    switch (command.action) {
      case "auto-start":
        if (!this.#managed) return json(response, 422, { error: "Auto-start is available with mine-labs run --spectator" });
        this.#controller.setAutoStart(command.enabled);
        return accepted({ enabled: command.enabled });
      case "start":
        if (!this.#controller.startPreparedTrial(command.trialId)) return json(response, 409, { error: "That scenario is not waiting to start" });
        return accepted();
      case "jobs":
        if (this.#activeTrials.size > 0 || this.#phase === "preparing" || this.#phase === "returning") return json(response, 409, { error: "Finish the active runs or return to Labs before changing parallelism" });
        if (command.jobs > this.#maxJobs) return json(response, 422, { error: `This session supports up to ${this.#maxJobs} workers` });
        if (this.#managed && command.jobs !== this.#controller.jobs) {
          // Release parked worker worlds when reducing concurrency; the existing
          // menu barrier also serialises a new batch behind that cleanup.
          this.#setStatus("Updating parallelism; closing idle worlds", "returning");
          this.#controller.returnToMenu();
        }
        this.#controller.setJobs(command.jobs);
        return accepted({ jobs: command.jobs });
      case "refresh": {
        if (!this.#refreshCatalog) return json(response, 422, { error: "Catalog refresh is available with mine-labs run --spectator" });
        this.#refreshing ??= this.#refreshCatalog().finally(() => { this.#refreshing = undefined; });
        this.onCatalogChanged(await this.#refreshing);
        return accepted({ count: this.#scenarios.length });
      }
      case "menu":
        if (!this.#managed) return json(response, 422, { error: "Return to Labs is available with mine-labs run --spectator" });
        this.#setStatus("Returning to Mine Labs; closing the scenario world", "returning");
        this.#controller.returnToMenu();
        return accepted();
      case "stop":
        // Phase first: `onTrialResult` uses "stopping" to stop overwriting the
        // status as the cancelled trials land.
        this.#setStatus("Stopping the session", "stopping");
        this.#controller.stop();
        return accepted();
      case "skip":
        this.#controller.skip();
        this.#setStatus(this.#activeTrials.size === 1 ? "Skipping the active trial" : "Skipping all active trials");
        return accepted();
      case "select":
        if (!command.scenario || !this.#scenarios.includes(command.scenario)) {
          return json(response, 422, { error: "scenario must name one of the available scenarios" });
        }
        this.#controller.selectScenario(command.scenario);
        this.#setStatus(
          this.#controller.singleScenarioEnabled
            ? `Switching single-test loop to ${command.scenario}`
            : `Switching to ${command.scenario}`,
          "preparing",
        );
        return accepted({ scenario: command.scenario });
      case "continuous":
        this.#controller.setContinuous(command.enabled);
        // With trials in flight the phase still belongs to them; the setting
        // only decides what happens once they finish.
        if (this.#activeTrials.size > 0) {
          this.#setStatus(
            command.enabled ? activeMessage(this.#activeTrials) : "Keep running will pause after the active trials",
          );
        } else {
          this.#setStatus(
            command.enabled ? "Keep running enabled; choose a scenario or folder to start" : "Keep running is off",
            this.#controller.canRepeat ? "waiting" : "paused",
          );
        }
        return accepted({ enabled: command.enabled });
      case "single":
        this.#controller.setSingleScenario(command.enabled);
        this.#setStatus(
          !command.enabled
            ? "Suite cycling enabled"
            : this.#activeTrials.size > 0
              ? "Active scenarios will repeat after this batch"
              : "Single-test loop enabled",
        );
        return accepted({ enabled: command.enabled });
      case "category":
        if (command.category && !this.#categories.some(({ name }) => name === command.category)) {
          return json(response, 422, { error: "category must name one of the available scenario folders" });
        }
        this.#controller.selectCategory(command.category);
        this.#setStatus(command.category ? `Switching to ${command.category}` : "Switching to the full suite");
        return accepted({ category: command.category ?? null });
    }
  }

  onGoalProgress(context: TrialContext, goal: GoalResult): void {
    if (this.#current?.trialId === context.trialId) this.#current.progress = goal;
  }
}

type ControlCommand =
  | { action: "auto-start"; enabled: boolean }
  | { action: "start"; trialId: string }
  | { action: "jobs"; jobs: number }
  | { action: "refresh" }
  | { action: "menu" }
  | { action: "stop" }
  | { action: "skip" }
  | { action: "select"; scenario: string }
  | { action: "continuous"; enabled: boolean }
  | { action: "single"; enabled: boolean }
  | { action: "category"; category?: string };

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const server = new UiServer(options);
  await server.start();
  return server;
}

async function loadRetainedResults(rootDir: string): Promise<{
  recent: UiResult[];
  statisticsWindow: UiResult[];
  scenarioStats: Map<string, ScenarioAccumulator>;
}> {
  const runsDir = join(rootDir, "runs");
  const directories = await readdir(runsDir, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const recent: UiResult[] = [];
  const statisticsWindow: UiResult[] = [];
  const scenarioStats = new Map<string, ScenarioAccumulator>();
  for (const directory of directories.filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    try {
      const result = JSON.parse(await readFile(join(runsDir, directory.name, "results.json"), "utf8")) as RunResult;
      if (!result || typeof result.scenario !== "string" || typeof result.outcome !== "string") continue;
      const uiResult: UiResult = {
        scenario: result.scenario,
        outcome: result.outcome,
        elapsedMs: Number(result.elapsedMs) || 0,
        detail: result.goal?.detail ?? "",
        finishedAt: timestampFromDirectory(directory.name),
      };
      recordStatistics(statisticsWindow, scenarioStats, uiResult, false);
      if (recent.length < MAX_RECENT_RESULTS) {
        recent.push(uiResult);
      }
    } catch {
      // One malformed retained report should not make the live UI unavailable.
    }
  }
  return { recent, statisticsWindow, scenarioStats };
}

function resultDetailPreview(detail: string): string {
  if (detail.length <= MAX_RESULT_PREVIEW_CHARS) return detail;
  const suffix = "… [full detail in results.json]";
  return detail.slice(0, MAX_RESULT_PREVIEW_CHARS - suffix.length) + suffix;
}

function ensureScenario(statistics: Map<string, ScenarioAccumulator>, scenario: string): ScenarioAccumulator {
  const existing = statistics.get(scenario);
  if (existing) return existing;
  const created: ScenarioAccumulator = {
    scenario,
    results: [],
  };
  statistics.set(scenario, created);
  return created;
}

function recordStatistics(overall: UiResult[], statistics: Map<string, ScenarioAccumulator>, result: UiResult, newest: boolean): void {
  recordInWindow(overall, result, newest);
  const scenario = ensureScenario(statistics, result.scenario);
  recordInWindow(scenario.results, result, newest);
}

function recordInWindow(window: UiResult[], result: UiResult, newest: boolean): void {
  if (newest) window.unshift(result);
  else if (window.length < MAX_STATISTICS_RESULTS) window.push(result);
  window.splice(MAX_STATISTICS_RESULTS);
}

function countResults(results: UiResult[]): UiSnapshot["totals"] {
  const totals = { runs: results.length, passed: 0, failed: 0, cancelled: 0 };
  for (const result of results) {
    if (result.outcome === "pass") totals.passed += 1;
    else if (result.outcome === "cancelled") totals.cancelled += 1;
    else totals.failed += 1;
  }
  return totals;
}

function orderedScenarioStats(statistics: Map<string, ScenarioAccumulator>, activeScenarios: string[]): UiScenarioStats[] {
  const active = new Set(activeScenarios);
  const historical = [...statistics.keys()].filter((scenario) => !active.has(scenario)).sort();
  return [...activeScenarios, ...historical].map((scenario) => {
    const value = ensureScenario(statistics, scenario);
    const totals = countResults(value.results);
    const totalElapsedMs = value.results.reduce((sum, result) => sum + result.elapsedMs, 0);
    return {
      scenario: value.scenario,
      ...totals,
      averageElapsedMs: totals.runs === 0 ? 0 : Math.round(totalElapsedMs / totals.runs),
      recentOutcomes: value.results.slice(0, MAX_RECENT_OUTCOMES).map((result) => result.outcome),
    };
  });
}

function timestampFromDirectory(name: string): string {
  const match = name.match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z/u);
  return match ? `${match[1]}:${match[2]}:${match[3]}.${match[4]}Z` : new Date().toISOString();
}

async function readControl(request: IncomingMessage): Promise<ControlCommand> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_CONTROL_BODY_BYTES) throw new Error("control request is too large");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  if (value.action === "start" && typeof value.trialId === "string" && value.trialId.length > 0) return { action: "start", trialId: value.trialId };
  if (value.action === "jobs" && typeof value.jobs === "number" && Number.isInteger(value.jobs) && value.jobs > 0) return { action: "jobs", jobs: value.jobs };
  if (value.action === "stop" || value.action === "skip" || value.action === "menu" || value.action === "refresh") return { action: value.action };
  if (value.action === "select" && typeof value.scenario === "string") {
    return { action: "select", scenario: value.scenario };
  }
  if ((value.action === "continuous" || value.action === "single" || value.action === "auto-start") && typeof value.enabled === "boolean") {
    return { action: value.action, enabled: value.enabled };
  }
  if (value.action === "category" && (value.category === undefined || typeof value.category === "string")) {
    return typeof value.category === "string" ? { action: "category", category: value.category } : { action: "category" };
  }
  throw new Error("control action must be stop, skip, menu, refresh, jobs, continuous/single/auto-start with enabled, start with trialId, select with a scenario, or category");
}

function groupCategories(scenarios: ScenarioSummary[]): UiScenarioCategory[] {
  const grouped = new Map<string, string[]>();
  for (const scenario of scenarios) {
    const names = grouped.get(scenario.category) ?? [];
    names.push(scenario.name);
    grouped.set(scenario.category, names);
  }
  return [...grouped].map(([name, names]) => ({ name, scenarios: names }));
}

function orderedActiveTrials(active: Map<string, UiActiveTrial>): UiActiveTrial[] {
  return [...active.values()]
    .sort((left, right) => left.workerIndex - right.workerIndex || left.trialId.localeCompare(right.trialId))
    .map((trial) => ({ ...trial }));
}

function activeMessage(active: Map<string, UiActiveTrial>): string {
  const trials = orderedActiveTrials(active);
  if (trials.length === 1) return `Running ${trials[0]!.scenario}`;
  return `Running ${trials.length} trials: ${trials.map(({ scenario }) => scenario).join(", ")}`;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}
