/** One worker owns one world; reports outlive replacement and never own that world. */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MinecraftServer, prepareWorldDir } from "../server/server.js";
import { runScenarioTrial, type RunResult, type ScenarioTrialOptions } from "../trial/run.js";
import { describeGoal } from "../trial/goals.js";
import { compactIsolatedRun, writeRunResult } from "../report/artifacts.js";
import { withRunLog } from "../report/run-log.js";
import { canResetScenario, worldCompatibilityKey } from "./reuse.js";
import type { SessionOptions, SessionScenario, TrialContext } from "./run.js";
import type { Scenario } from "../scenario/schema.js";

interface HeldWorld {
  server: MinecraftServer;
  /** `worldCompatibilityKey` of the scenario that created it; only a match may reuse it. */
  key: string;
  id: string;
  /** Put the arena back for the next trial; set by a trial that left a restorable world. */
  restore?: (log: (message: string) => void) => Promise<void>;
}

export function createSessionWorker(options: SessionOptions, workerIndex: number, serverRoot: string) {
  const username = workerIndex === 0 ? options.spectator?.username : undefined;
  const root = join(serverRoot, `worker-${workerIndex + 1}`);
  let held: HeldWorld | undefined;
  let running: Promise<RunResult> | undefined;
  let closing = Promise.resolve();
  let currentLog = options.log;
  const release = async (): Promise<void> => {
    if (username) options.observer?.onConnectionChanged?.(null);
    const previous = held;
    held = undefined;
    if (previous) {
      await previous.server.stop();
      await compactIsolatedRun(root);
    }
  };
  /**
   * The world this trial runs in: the held one reset in place when the scenario
   * can reuse it, otherwise a freshly started server. A failed reset is not an
   * error, only a reason to replace the server.
   */
  const acquireWorld = async (scenario: Scenario, reusable: boolean, log: (message: string) => void,
    prepare: (message: string) => void, signal?: AbortSignal): Promise<HeldWorld> => {
    const key = worldCompatibilityKey(scenario);
    signal?.throwIfAborted();
    if (!reusable || held?.key !== key || !held.restore) await release();
    if (held) {
      prepare(`Resetting world for ${scenario.name}`);
      try {
        await held.restore!(log);
        held.restore = undefined;
      } catch (error) {
        log(`Reset failed; replacing the server: ${String(error)}`);
        await release();
      }
    }
    signal?.throwIfAborted();
    if (!held) {
      prepare(`Preparing ${scenario.name}: ${scenario.world.type} world`);
      const server = await MinecraftServer.create({
        version: scenario.minecraft.version, root, log: message => currentLog(message),
        host: options.host, preferPort: options.preferPort, worldType: scenario.world.type,
        seed: scenario.world.seed, structures: scenario.world.structures,
        spectatorNames: username ? [username] : [],
      });
      held = { server, key, id: `worker-${workerIndex + 1}-world-${randomUUID()}` };
      await prepareWorldDir(server.worldDir);
      await server.start(signal);
    }
    return held;
  };
  const execute = async ({ scenario }: SessionScenario, context: TrialContext, signal?: AbortSignal,
    preparation?: Pick<ScenarioTrialOptions, "onWorldPrepared" | "holdPreparedWorld">): Promise<RunResult> => {
    const startedAt = Date.now();
    const reusable = !options.isolated && canResetScenario(scenario);
    return withRunLog(context.runDir, options.log, async log => {
      currentLog = log;
      try {
        const prepare = (message: string): void => {
          log(message);
          if (username) options.observer?.onPreparation?.(message);
        };
        let result: RunResult;
        try {
          const current = await acquireWorld(scenario, reusable, log, prepare, signal);
          result = await runScenarioTrial({
            scenario, server: current.server, runDir: context.runDir, log,
            waitForSpectator: Boolean(username), signal, startedAt, reuseServer: reusable,
            spectatorUsername: username, holdPreparedWorld: preparation?.holdPreparedWorld,
            onWorldPrepared: preparation?.onWorldPrepared,
            deferReset: restore => { current.restore = restore; },
            onPrepared: async () => {
              signal?.throwIfAborted();
              if (username) options.observer?.onConnectionChanged?.({
                id: current.id, host: current.server.host, port: current.server.gamePort,
                focusPlayer: scenario.players[0]?.name,
              });
            },
            onStarted: () => options.observer?.onTrialRunning?.(context),
            onGoalProgress: goal => options.observer?.onGoalProgress?.(context, goal),
          });
          // An unsuccessful arrangement cannot certify that the world is reusable.
          if (result.outcome === "error") current.restore = undefined;
        } catch (error) {
          await release();
          const detail = error instanceof Error ? error.message : String(error);
          result = { scenario: context.scenario, outcome: signal?.aborted ? "cancelled" : "error",
            elapsedMs: Date.now() - startedAt, goal: { state: "pending", detail },
            goalText: describeGoal(scenario.goal), error: detail };
        }
        result.scenario = context.scenario;
        await writeRunResult(context.runDir, result);
        return result;
      } finally { currentLog = options.log; }
    });
  };
  return {
    runTrial: (entry: SessionScenario, context: TrialContext, signal?: AbortSignal,
      preparation?: Pick<ScenarioTrialOptions, "onWorldPrepared" | "holdPreparedWorld">) => {
      running = closing.then(() => execute(entry, context, signal, preparation));
      return running;
    },
    close: () => {
      const active = running;
      closing = closing.then(async () => { await active?.catch(() => {}); await release(); });
      return closing;
    },
  };
}
