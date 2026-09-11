/** Natural-world verification: compatible, separated attempts share a fresh world. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Scenario, type GoalCondition, scenarioSchema } from "../scenario/schema.js";
import { MinecraftServer, prepareWorldDir } from "../server/server.js";
import { acceptedNoOp, compileScenario } from "../scenario/compile.js";
import { runScenario, runVerificationTrial, type RunResult } from "../trial/run.js";
import { compactIsolatedRun, writeRunResult } from "../report/artifacts.js";
import { withRunLog } from "../report/run-log.js";
import { watchOperatorSpectators } from "../player/operators.js";

type VerificationAttempt = Scenario & {
  verification: NonNullable<Scenario["verification"]>;
  players: [Scenario["players"][number] & { pos: [number, number, number] }];
};

export interface VerificationOptions {
  scenarios: Scenario[];
  /** A new invocation directory; existing evidence is never overwritten. */
  rootDir: string;
  /** Shared is the normal mode; isolated is a fresh-server replay or throughput control. */
  mode: "shared" | "isolated";
  jobs: number;
  repeat?: number;
  preferPort?: number;
  signal?: AbortSignal;
  log: (message: string) => void;
}

export interface VerificationSummary {
  mode: VerificationOptions["mode"];
  elapsedMs: number;
  servers: number;
  results: RunResult[];
}

/** Validate before any server starts. Raw fixture commands cannot own a shared world. */
export function validateVerification(scenario: Scenario): asserts scenario is VerificationAttempt {
  const fail = (detail: string): never => { throw new Error(`${scenario.name ?? "scenario"}: ${detail}`); };
  if (!scenario.verification) fail("verify requires verification.radius; use run for isolated fixtures");
  if (scenario.world.type !== "default" || scenario.world.seed === undefined) fail("verification requires a default world and an explicit seed");
  if (scenario.players.length !== 1 || !Array.isArray(scenario.players[0]?.pos)) fail("verification requires one player with an absolute spawn position per attempt");
  if (scenario.players.some((player) => player.op)) fail("verification clients cannot be operators");
  for (const field of ["geometry", "entities", "setup", "reset", "tick"] as const) {
    if (scenario[field].length) fail(`verification cannot use ${field}; put common difficulty and gamerules in world`);
  }
  const checkGoal = (goal: GoalCondition): void => {
    if (goal.kind === "all" || goal.kind === "any") return goal.goals.forEach(checkGoal);
    if (!["hasItem", "completion", "health", "survive", "reach"].includes(goal.kind)) {
      fail(`goal '${goal.kind}' is not player-scoped verification evidence`);
    }
  };
  checkGoal(scenario.goal);
}

function worldKey(scenario: Scenario): string {
  return JSON.stringify({
    version: scenario.minecraft.version,
    ...scenario.world,
    gamerules: Object.entries(scenario.world.gamerules).sort(([a], [b]) => a.localeCompare(b)),
  });
}

/** Never translate coordinates: another location is another test, not the same seeded fixture. */
export function planVerificationBatches(scenarios: Scenario[], jobs: number): Scenario[][] {
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error("verification jobs must be a positive integer");
  const attempts = scenarios.map((scenario) => { validateVerification(scenario); return scenario; });
  const batches: VerificationAttempt[][] = [];
  for (const scenario of attempts) {
    const batch = batches.find((candidate) => candidate.length < jobs && candidate.every((other) => {
      if (worldKey(other) !== worldKey(scenario)) return false;
      const a = other.players[0].pos;
      const b = scenario.players[0].pos;
      // Leave two chunks between declared travel envelopes for nearby block interactions.
      return Math.hypot(a[0] - b[0], a[2] - b[2]) > other.verification.radius + scenario.verification.radius + 32;
    }));
    if (batch) batch.push(scenario);
    else batches.push([scenario]);
  }
  return batches;
}

/** A verification manifest describes one script on one seed at several real locations. */
export function expandVerificationLocations(scenarios: Scenario[]): VerificationAttempt[] {
  return scenarios.flatMap((scenario) => {
    if (!scenario.verification) throw new Error(`${scenario.name}: verify requires verification.locations and radius`);
    return scenario.verification.locations.map((pos, index) => {
      const attempt = scenarioSchema.parse({
        ...scenario,
        name: `${scenario.name ?? "verification"}@${index + 1}`,
        players: scenario.players.map((player) => ({ ...player, pos })),
      });
      validateVerification(attempt);
      return attempt;
    });
  });
}

/** Remap declared player references together; scripts receive the resolved identity in init. */
export function nameVerificationPlayer(scenario: Scenario, sequence: number): Scenario {
  const name = `Verify${sequence}`;
  const renameGoal = (goal: GoalCondition): GoalCondition => {
    if (goal.kind === "all" || goal.kind === "any") return { ...goal, goals: goal.goals.map(renameGoal) };
    return { ...goal, who: name };
  };
  return scenarioSchema.parse({
    ...scenario,
    players: scenario.players.map((player) => ({ ...player, name })),
    goal: renameGoal(scenario.goal),
  });
}

export async function runVerification(options: VerificationOptions): Promise<VerificationSummary> {
  if (!options.scenarios.length) throw new Error("verification requires at least one scenario");
  const scenarios = expandVerificationLocations(options.scenarios);
  const batches = planVerificationBatches(scenarios, options.jobs);
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("verification repeat must be a positive integer");
  await mkdir(dirname(options.rootDir), { recursive: true });
  await mkdir(options.rootDir);
  const startedAt = Date.now();
  const summary: VerificationSummary = { mode: options.mode, elapsedMs: 0, servers: 0, results: [] };
  let sequence = 0;
  const attempt = async (input: Scenario, server?: MinecraftServer): Promise<void> => {
    const id = ++sequence;
    const scenario = nameVerificationPlayer(input, id);
    const runDir = join(options.rootDir, "runs", String(id).padStart(5, "0"));
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "scenario.json"), JSON.stringify(scenario, null, 2));
    const result = await withRunLog(runDir, (message) => options.log(`[${scenario.name}/${id}] ${message}`), (log) => server
      ? runVerificationTrial({ scenario, runDir, server, log, signal: options.signal })
      : runScenario({ scenario, runDir, log, signal: options.signal, preferPort: options.preferPort }));
    await writeRunResult(runDir, result);
    if (!server) await compactIsolatedRun(runDir);
    summary.results.push(result);
  };

  try {
    for (let cycle = 0; cycle < repeat && !options.signal?.aborted; cycle++) {
      if (options.mode === "isolated") {
        let next = 0;
        const workers = Array.from({ length: Math.min(options.jobs, scenarios.length) }, async () => {
          while (!options.signal?.aborted) {
            const scenario = scenarios[next++];
            if (!scenario) return;
            summary.servers++;
            await attempt(scenario);
          }
        });
        const settled = await Promise.allSettled(workers);
        const failure = settled.find((item) => item.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        continue;
      }
      for (const batch of batches) {
        if (options.signal?.aborted) break;
        const first = batch[0]!;
        const serverDir = join(options.rootDir, "servers", String(++summary.servers));
        const server = await MinecraftServer.create({
          version: first.minecraft.version, root: serverDir, log: options.log,
          worldType: "default", seed: first.world.seed, preferPort: options.preferPort,
          structures: first.world.structures,
          maxPlayers: batch.length + 1,
        });
        try {
          await prepareWorldDir(server.worldDir);
          await server.start();
          const rcon = server.rcon!;
          for (const command of compileScenario(first).setup) {
            await rcon.executeChecked(command, { acceptedNoOp: acceptedNoOp(command) });
          }
          const operatorWatch = watchOperatorSpectators({
            commands: rcon, operatorNames: server.operatorNames, clientPlayerNames: [], log: options.log,
          });
          options.log(`verification batch: seed ${first.world.seed}, ${batch.length} independent attempts`);
          const tickSamples: Array<{ elapsedMs: number; query: string }> = [];
          let sampling = Promise.resolve();
          const timer = setInterval(() => {
            sampling = sampling.then(async () => {
              const query = await rcon.command("tick query").catch((error: unknown) => String(error));
              tickSamples.push({ elapsedMs: Date.now() - startedAt, query });
            });
          }, 5000);
          try {
            const settled = await Promise.allSettled(batch.map((scenario) => attempt(scenario, server)));
            const failure = settled.find((item) => item.status === "rejected");
            if (failure?.status === "rejected") throw failure.reason;
          } finally {
            clearInterval(timer);
            await sampling;
            await writeFile(join(serverDir, "tick-query.txt"), JSON.stringify(tickSamples, null, 2));
            operatorWatch.stop();
          }
        } finally {
          await server.stop();
          await compactIsolatedRun(serverDir);
        }
      }
    }
  } finally {
    summary.elapsedMs = Date.now() - startedAt;
    await writeFile(join(options.rootDir, "verification.json"), JSON.stringify(summary, null, 2));
  }
  return summary;
}
