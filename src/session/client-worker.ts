import { randomUUID } from "node:crypto";
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describeGoal } from "../trial/goals.js";
import type { RunResult } from "../trial/run.js";
import type { SessionOptions, SessionScenario, TrialContext } from "./run.js";
import { createSessionWorker } from "./worker.js";

interface Preparation {
  entry: SessionScenario;
  directory: string;
  serverDirectory: string;
  context?: TrialContext;
  cancellation: AbortController;
  activate: () => void;
  worker: ReturnType<typeof createSessionWorker>;
  result: Promise<RunResult>;
  failed: boolean;
}

/** The observer owns one active server and at most one speculative successor. */
export function createClientSessionWorker(
  options: SessionOptions,
  serverRoot: string,
  nextEntry: () => SessionScenario | undefined,
  createWorker = createSessionWorker,
) {
  let current: Preparation | undefined;
  let previous: Preparation | undefined;
  let standby: Preparation | undefined;
  let running = false;
  let switching = false;
  let revision = 0;
  let refreshTail = Promise.resolve();
  let retiring = Promise.resolve();
  let execution: Promise<RunResult> | undefined;
  let executionCancellation: AbortController | undefined;

  const dispose = async (preparation: Preparation | undefined): Promise<void> => {
    if (!preparation) return;
    preparation.cancellation.abort("discarded preparation");
    preparation.activate();
    await preparation.worker.close();
    await rm(preparation.directory, { recursive: true, force: true });
    await rm(preparation.serverDirectory, { recursive: true, force: true });
  };

  const prepare = (entry: SessionScenario): Preparation => {
    const id = randomUUID();
    const directory = join(serverRoot, "preparations", id);
    const serverDirectory = join(serverRoot, id);
    const cancellation = new AbortController();
    const activation = Promise.withResolvers<void>();
    let preparation: Preparation;
    const worker = createWorker({
      ...options,
      // Each standby starts pristine; it cannot restore the world being watched.
      isolated: true,
      observer: {
        onPreparation: message => {
          if (preparation === current) options.observer?.onPreparation?.(message);
        },
        onConnectionChanged: connection => {
          if (preparation === current) {
            // A cold replacement clears its own empty slot during startup;
            // keep the previous world visible until the new target is ready.
            if (!connection && previous) return;
            if (connection) retirePrevious();
            options.observer?.onConnectionChanged?.(connection);
          }
        },
        onTrialRunning: async () => {
          if (!preparation.context) throw new Error("Standby trial was not selected");
          await options.observer?.onTrialRunning?.(preparation.context);
          switching = false;
          running = true;
          refresh();
        },
        onGoalProgress: (_context, goal) => {
          if (preparation.context) options.observer?.onGoalProgress?.(preparation.context, goal);
        },
      },
    }, 0, serverDirectory);
    // Speculation does not claim a sequence, consume a batch permit, or appear
    // in results. Clients keep this artifact path until they have stopped.
    const context: TrialContext = {
      trialId: `preparing-${id}`, sequence: 0, workerIndex: 0, cycle: 0,
      scenarioIndex: 0, scenarioCount: 0, scenario: entry.id ?? entry.scenario.name ?? "scenario",
      goalText: describeGoal(entry.scenario.goal), runDir: directory, startedAt: new Date().toISOString(),
    };
    const signals = [cancellation.signal, options.signal, options.controller?.signal]
      .filter((signal): signal is AbortSignal => Boolean(signal));
    const result = worker.runTrial(entry, context, AbortSignal.any(signals), {
      holdPreparedWorld: true,
      onWorldPrepared: async () => {
        options.log(`Prepared ${context.scenario}; waiting for selection`);
        await activation.promise;
      },
    });
    preparation = { entry, directory, serverDirectory, cancellation, activate: activation.resolve, worker, result, failed: false };
    void result.then(result => { preparation.failed = result.outcome === "error"; }, () => { preparation.failed = true; });
    return preparation;
  };

  function retirePrevious(): void {
    if (!previous) return;
    const old = previous;
    previous = undefined;
    retiring = dispose(old);
    void retiring.catch(() => undefined);
  }

  /** Called after claims and operator changes; only the current prediction survives. */
  function refresh(): void {
    if (switching) return;
    const entry = running && !current?.cancellation.signal.aborted ? nextEntry() : undefined;
    const requestedRevision = ++revision;
    if (standby?.entry !== entry) standby?.cancellation.abort("next scenario changed");
    refreshTail = refreshTail.then(async () => {
      if (requestedRevision !== revision) return;
      if (standby?.entry === entry && !standby?.cancellation.signal.aborted) return;
      const stale = standby;
      standby = undefined;
      await dispose(stale);
      // A retiring server must release its resources before another is booted.
      await retiring;
      if (requestedRevision !== revision || !entry || !running) return;
      options.log(`Preparing next scenario: ${entry.id ?? entry.scenario.name}`);
      standby = prepare(entry);
    });
    void refreshTail.catch(() => undefined);
  }

  const runTrial = async (entry: SessionScenario, context: TrialContext, signal?: AbortSignal): Promise<RunResult> => {
    running = false;
    switching = true;
    ++revision;
    let active: Preparation | undefined;
    const cancel = (): void => { active?.cancellation.abort(signal?.reason); };
    try {
      await refreshTail;
      await retiring;
      let selected = standby;
      standby = undefined;
      if (selected && (selected.entry !== entry || selected.failed || selected.cancellation.signal.aborted)) {
        await dispose(selected);
        selected = undefined;
      }
      previous = current;
      current = undefined;
      selected ??= prepare(entry);
      current = selected;
      selected.context = context;
      active = selected;
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      active.activate();
      const result = await active.result;
      // Copy only after clients and their log handles have closed. The real
      // run directory is protected by the scheduler's normal retention set.
      await cp(active.directory, context.runDir, { recursive: true });
      await rm(active.directory, { recursive: true, force: true });
      return result;
    } finally {
      if (previous) {
        retirePrevious();
        options.observer?.onConnectionChanged?.(null);
      }
      switching = false;
      running = false;
      signal?.removeEventListener("abort", cancel);
    }
  };

  return {
    refresh,
    runTrial(entry: SessionScenario, context: TrialContext, signal?: AbortSignal): Promise<RunResult> {
      executionCancellation = new AbortController();
      execution = runTrial(entry, context, signal
        ? AbortSignal.any([signal, executionCancellation.signal]) : executionCancellation.signal);
      return execution;
    },
    async close(): Promise<void> {
      running = false;
      ++revision;
      executionCancellation?.abort("session closed");
      standby?.cancellation.abort("session closed");
      current?.cancellation.abort("session closed");
      // Let the selected run finish copying its evidence before disposal.
      await execution?.catch(() => undefined);
      const pending = standby;
      const active = current;
      const old = previous;
      standby = undefined;
      current = undefined;
      previous = undefined;
      const outcomes = await Promise.allSettled([refreshTail, retiring, dispose(pending), dispose(active), dispose(old)]);
      options.observer?.onConnectionChanged?.(null);
      const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(failure => failure.reason), "Client servers failed to close");
    },
  };
}
