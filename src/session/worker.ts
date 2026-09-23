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

export function createSessionWorker(options: SessionOptions, workerIndex: number, serverRoot: string) {
  const username = workerIndex === 0 ? options.spectator?.username : undefined;
  const root = join(serverRoot, `worker-${workerIndex + 1}`);
  let held: { server: MinecraftServer; key: string; id: string; restore?: (log: (message: string) => void) => Promise<void> } | undefined;
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
  const execute = async ({ scenario }: SessionScenario, context: TrialContext, signal?: AbortSignal,
    preparation?: Pick<ScenarioTrialOptions, "onWorldPrepared" | "holdPreparedWorld">): Promise<RunResult> => {
    const startedAt = Date.now();
    const reusable = !options.isolated && canResetScenario(scenario);
    const key = worldCompatibilityKey(scenario);
    return withRunLog(context.runDir, options.log, async log => {
      currentLog = log;
      try {
        const prepare = (message: string): void => {
          log(message);
          if (username) options.observer?.onPreparation?.(message);
        };
        const result = await (async (): Promise<RunResult> => {
          try {
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
            const current = held;
            const trial = await runScenarioTrial({
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
            if (trial.outcome === "error") current.restore = undefined;
            return trial;
          } catch (error) {
            await release();
            const detail = error instanceof Error ? error.message : String(error);
            return { scenario: context.scenario, outcome: signal?.aborted ? "cancelled" : "error",
              elapsedMs: Date.now() - startedAt, goal: { state: "pending", detail },
              goalText: describeGoal(scenario.goal), error: detail };
          }
        })();
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
