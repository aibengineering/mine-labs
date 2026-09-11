/**
 * Run one scenario as a measured trial and decide what happened.
 *
 * This is the centre of the harness: it arranges the world, launches the
 * scenario's clients, holds them at the start line until the fixture is really
 * built, then polls the goal until it settles — passed, failed, timed out, or
 * cancelled — and takes everything down again whatever the outcome.
 *
 * The ordering here is the whole point, and most of it is defending against a
 * measurement that would otherwise be quietly wrong. Clients are connected and
 * prepared *before* any of them is told to start, so the first client does not
 * get a head start on the last. The goal's initial state is sampled before the
 * clients move, so a scenario that asks "kill all the zombies" cannot pass
 * because the zombies never spawned. Every wait is bounded or cancellable, so a
 * wedged client cannot strand a trial that has already been judged.
 *
 * It deliberately knows nothing about Minecraft's command grammar — that lives
 * in `scenario/compile.ts` — and nothing about how the goal is evaluated, which
 * lives in `trial/goals.ts`. What it owns is sequence, timing, and cleanup.
 */

import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import type { GoalCondition, Scenario } from "../scenario/schema.js";
import { MinecraftServer, prepareWorldDir } from "../server/server.js";
import {
  acceptedNoOp,
  compileScenario,
  pinRegionCommand,
  regionLoadedProbes,
  unpinCommands,
  UNLOADED_POSITION,
  writeDatapack,
  CLEAR_ENTITIES,
  FORCELOAD_CHUNK_LIMIT,
  type ArenaSnapshot,
  type SetupRegion,
} from "../scenario/compile.js";
import { evaluateGoal, describeGoal, observeInitialGoalState, type GoalResult } from "./goals.js";
import { preparePlayerForTrial } from "../player/prepare.js";
import { watchOperatorSpectators } from "../player/operators.js";
import { delay } from "../util/fs.js";
import { launchScenarioClient, type ScenarioClientProcess } from "../client/process.js";
import type { ClientCompletion } from "../client/protocol.js";

export interface RunResult {
  /** Reproducible input and execution class, also retained for shared-world trials. */
  verification?: { seed: number | string; players: Scenario["players"]; radius: number };
  scenario: string;
  outcome: "pass" | "fail" | "timeout" | "error" | "cancelled";
  /**
   * Whole per-trial cost through goal settlement. Isolated runs include server
   * boot and arrangement; shared verification records batch boot/shutdown in
   * VerificationSummary.elapsedMs instead of charging every client for it.
   */
  elapsedMs: number;
  /**
   * Time the bots were actually running, from `start` to the goal settling.
   *
   * This is the number to compare two implementations with. `elapsedMs` is
   * dominated by a fixed setup cost: booting Minecraft and arranging the
   * world take about the same time whatever the client then does, so two
   * clients whose behaviour differs substantially can post near-identical
   * `elapsedMs` and look like a tie. Absent when the trial never got as far
   * as starting its clients.
   */
  runtimeMs?: number;
  goal: GoalResult;
  goalText: string;
  error?: string;
  /** Game port the server listened on during this run (for client spectators). */
  gamePort?: number;
}

export interface RunOptions {
  onGoalProgress?: (goal: GoalResult) => void;
  scenario: Scenario;
  runDir: string;
  preferPort?: number;
  log: (s: string) => void;
  signal?: AbortSignal;
}

export interface ScenarioTrialOptions {
  /** Transfer restoration to the session so the completed world remains inspectable. */
  deferReset?: (restore: (log: (message: string) => void) => Promise<void>) => void;
  onGoalProgress?: (goal: GoalResult) => void;
  /** The arranged clients are waiting at the start line; a managed spectator may connect now. */
  onPrepared?: () => void | Promise<void>;
  /** World setup is complete; hold here before players join the frozen standby. */
  onWorldPrepared?: () => void | Promise<void>;
  /** Keep a speculative fixture frozen until its observer has joined. */
  holdPreparedWorld?: boolean;
  spectatorUsername?: string;
  onStarted?: () => void | Promise<void>;
  runDir: string;
  scenario: Scenario;
  server: MinecraftServer;
  log: (s: string) => void;
  /** Wait for the dashboard's spectator connection before starting the clients. */
  waitForSpectator?: boolean;
  /** Clear server-side player state and non-player entities before a reused-server trial. */
  reuseServer?: boolean;
  startedAt?: number;
  signal?: AbortSignal;
}

const GOAL_POLL_MS = 250;

/** Run one isolated scenario with a fresh server and world. */
export async function runScenario(opts: RunOptions): Promise<RunResult> {
  const startedAt = Date.now();
  try {
    const server = await MinecraftServer.create({
      version: opts.scenario.minecraft.version,
      root: opts.runDir,
      log: opts.log,
      preferPort: opts.preferPort,
      worldType: opts.scenario.world.type,
      seed: opts.scenario.world.seed,
      structures: opts.scenario.world.structures,
    });
    // Nested so each block has one job: the inner one guarantees the server is
    // stopped once it exists, the outer one turns any failure — including a
    // server that never started — into a reported result rather than a throw.
    try {
      await prepareWorldDir(server.worldDir);
      await server.start();
      return await runScenarioTrial({
        runDir: opts.runDir,
        scenario: opts.scenario,
        server,
        log: opts.log,
        startedAt,
        onGoalProgress: opts.onGoalProgress,
        signal: opts.signal,
      });
    } finally {
      await server.stop();
    }
  } catch (error) {
    const result = emptyResult(opts.scenario, startedAt);
    result.outcome = "error";
    result.error = error instanceof Error ? error.message : String(error);
    result.elapsedMs = Date.now() - startedAt;
    opts.log(`run error: ${result.error}`);
    return result;
  }
}

/** Arrange and measure one trial on an already-running Mine Labs server. */
export async function runScenarioTrial(opts: ScenarioTrialOptions): Promise<RunResult> {
  const { scenario, server, log } = opts;
  const startedAt = opts.startedAt ?? Date.now();
  const result = emptyResult(scenario, startedAt);
  result.gamePort = server.gamePort;
  const clients = createTrialClientState();
  let clientsPrepared = false;
  // Armed before the world is arranged, so a human who is already connected —
  // or who joins while the fixture is being built — is a spectator before the
  // mobs exist rather than a survival body standing in the arrangement.
  const operatorWatch = server.rcon
    ? watchOperatorSpectators({
        commands: server.rcon,
        operatorNames: server.operatorNames,
        clientPlayerNames: scenario.players.map((player) => player.name),
        viewpointPlayer: scenario.players[0]?.name,
        viewpointReady: () => clientsPrepared,
        log,
      })
    : undefined;

  // Taken before anything touches the world and held for the `finally` below.
  // If arrangement itself fails halfway the arena is already dirty, and that is
  // exactly when the next trial most needs it put back — so this cannot be the
  // return value of `arrangeScenario`, which a throw would discard.
  let arenaBackup: ArenaSnapshot | null = null;

  try {
    if (opts.reuseServer) arenaBackup = await snapshotArena(server, scenario, log);
    const releaseArena = await arrangeScenario(server, scenario, log, Boolean(opts.reuseServer), Boolean(opts.holdPreparedWorld));
    try {
      await waitForClientPhase(Promise.resolve(opts.onWorldPrepared?.()), opts.signal, "trial cancelled while world was prepared");
      await connectScenarioClients({ ...opts, clients });
    } finally {
      await releaseArena();
    }
    await waitForClientPhase(Promise.resolve(opts.onPrepared?.()), opts.signal, "trial cancelled while prepared");
    if (opts.waitForSpectator) await waitForSpectator(server, scenario.players.length, log, opts.signal, opts.spectatorUsername);
    opts.signal?.throwIfAborted();
    if (clients.completions.size > 0) throw new Error("A scenario client completed or exited before the trial started");
    clientsPrepared = true;
    await operatorWatch?.place();
    await activateScenario(server, scenario, Boolean(opts.holdPreparedWorld));
    const initialGoalState = server.rcon
      ? await observeInitialGoalState(scenario.goal, server.rcon)
      : new Map<GoalCondition, Record<string, unknown>>();
    await measureClients(opts, clients, result, initialGoalState);
  } catch (error) {
    if (opts.signal?.aborted) {
      const reason = typeof opts.signal.reason === "string" ? opts.signal.reason : "operator request";
      result.outcome = "cancelled";
      result.goal = { state: "pending", detail: `trial cancelled: ${reason}` };
      log(result.goal.detail);
    } else {
      result.outcome = "error";
      result.error = error instanceof Error ? error.message : String(error);
      log(`run error: ${result.error}`);
    }
  } finally {
    result.elapsedMs = Date.now() - startedAt;
    operatorWatch?.stop();
    await stopScenarioClients(clients);
    // The session retains the world for inspection and restores it before reuse.
    if (opts.reuseServer && arenaBackup) {
      const backup = arenaBackup;
      const restore = (restoreLog: (message: string) => void) => clearScenario(server, scenario, backup, restoreLog);
      if (opts.deferReset) opts.deferReset(restore);
      else await restore(log);
    }
  }
  return result;
}

/** A shared-world attempt owns only its clients. World setup and disposal belong to its batch. */
export async function runVerificationTrial(opts: ScenarioTrialOptions): Promise<RunResult> {
  const result = emptyResult(opts.scenario, Date.now());
  result.gamePort = opts.server.gamePort;
  const startedAt = Date.now();
  const clients = createTrialClientState();
  try {
    opts.signal?.throwIfAborted();
    await connectScenarioClients({ ...opts, clients });
    await measureClients(opts, clients, result);
  } catch (error) {
    result.outcome = opts.signal?.aborted ? "cancelled" : "error";
    result.error = error instanceof Error ? error.message : String(error);
    opts.log(result.error);
  } finally {
    result.elapsedMs = Date.now() - startedAt;
    await stopScenarioClients(clients);
  }
  return result;
}

async function measureClients(
  opts: ScenarioTrialOptions,
  clients: TrialClientState,
  result: RunResult,
  initialGoalState?: Map<GoalCondition, Record<string, unknown>>,
): Promise<void> {
  if (!opts.signal?.aborted) {
    await opts.onStarted?.();
    opts.signal?.throwIfAborted();
    if (opts.holdPreparedWorld) await opts.server.rcon!.executeChecked("tick unfreeze");
    for (const client of clients.processes.values()) client.start();
  }
  const runningSince = Date.now();
  const settlement = await awaitScenarioGoal({ ...opts, clients, initialGoalState });
  result.runtimeMs = Date.now() - runningSince;
  result.goal = settlement.goal;
  result.outcome = settlement.outcome;
  opts.log(settlement.log);
}

interface TrialClientState {
  processes: Map<string, ScenarioClientProcess>;
  chat: Map<string, string[]>;
  completions: Map<string, ClientCompletion>;
}

function createTrialClientState(): TrialClientState {
  return {
    processes: new Map(),
    chat: new Map(),
    completions: new Map(),
  };
}

async function connectScenarioClients(
  opts: ScenarioTrialOptions & { clients: TrialClientState },
): Promise<void> {
  const { scenario, server, log, clients } = opts;
  if (!server.rcon) throw new Error("rcon unavailable after arrangement");
  const { client: clientCommand, ...definition } = scenario;
  const artifactsDirectory = join(resolve(opts.runDir), "artifacts");
  await mkdir(artifactsDirectory, { recursive: true });

  for (const player of scenario.players) {
    clients.chat.set(player.name, []);
    const client = launchScenarioClient({
      client: clientCommand,
      scenario: definition,
      host: "127.0.0.1",
      port: server.gamePort,
      username: player.name,
      version: scenario.minecraft.version,
      artifactsDirectory,
      log,
      onChat: (message) => clients.chat.get(player.name)?.push(message),
      onCompletion: (completion) => recordClientCompletion(player.name, completion, clients, log),
    });
    clients.processes.set(player.name, client);
    await waitForClientPhase(
      client.ready,
      opts.signal,
      `trial cancelled before client '${player.name}' became ready`,
    );
    await waitForPlayer(server, player.name, opts.signal);
    await preparePlayerForTrial({
      commands: server.rcon,
      player,
      dimension: scenario.world.dimension,
      resetReusablePlayer: Boolean(opts.reuseServer),
    });
    await server.rcon.preparePlayerMetrics(player.name);
    if (player.pos) await delay(300);
    log(`client '${player.name}' arranged`);
  }

  for (const client of clients.processes.values()) client.arranged();
  for (const [name, client] of clients.processes) {
    await waitForClientPhase(
      client.prepared,
      opts.signal,
      `trial cancelled before client '${name}' observed its arrangement`,
    );
    log(`client '${name}' prepared`);
  }
}

function recordClientCompletion(
  player: string,
  completion: ClientCompletion,
  clients: TrialClientState,
  log: (message: string) => void,
): void {
  if (clients.completions.has(player)) {
    log(`client '${player}' ignored duplicate completion report`);
    return;
  }
  clients.completions.set(player, completion);
  log(`client '${player}' reported ${completion.status}${completion.detail ? `: ${completion.detail}` : ""}`);
}

interface GoalSettlement {
  outcome: "pass" | "fail" | "timeout" | "cancelled";
  goal: GoalResult;
  log: string;
}

/** Exported for the settlement test; production callers go through `runScenarioTrial`. */
export async function awaitScenarioGoal(options: {
  onGoalProgress?: (goal: GoalResult) => void;
  scenario: Scenario;
  server: MinecraftServer;
  clients: TrialClientState;
  initialGoalState?: Map<GoalCondition, Record<string, unknown>>;
  signal?: AbortSignal;
}): Promise<GoalSettlement> {
  if (!options.server.rcon) throw new Error("rcon unavailable while evaluating the goal");
  const timeout = options.scenario.goal.timeout ?? 120;
  const deadline = Date.now() + timeout * 1000;
  const context = {
    players: options.scenario.players.map((player) => player.name),
    dimension: options.scenario.world.dimension,
    observer: options.server.rcon,
    chat: options.clients.chat,
    completions: options.clients.completions,
    startedAt: Date.now(),
    state: options.initialGoalState ?? new Map<GoalCondition, Record<string, unknown>>(),
  };

  for (;;) {
    if (options.signal?.aborted) {
      const reason = typeof options.signal.reason === "string" ? options.signal.reason : "operator request";
      const goal = { state: "pending", detail: `trial cancelled: ${reason}` } as const;
      return { outcome: "cancelled", goal, log: goal.detail };
    }
    if (options.scenario.verification) {
      for (const player of options.scenario.players) {
        const pos = player.pos;
        if (!Array.isArray(pos)) throw new Error("verification requires an absolute player position");
        if (!(await options.server.rcon.playerWithinHorizontalRadius(
          player.name, pos[0], pos[2], options.scenario.verification.radius,
        ))) {
          const deaths = await options.server.rcon.playerDeaths(player.name);
          const detail = `${player.name} was not observed within its verification radius; recorded deaths: ${deaths}`;
          const goal = { state: "failed", detail } as const;
          return { outcome: "fail", goal, log: goal.detail };
        }
      }
    }
    const goal = await evaluateGoal(options.scenario.goal, context);
    options.onGoalProgress?.(goal);
    if (goal.state === "passed") return { outcome: "pass", goal, log: `goal satisfied: ${goal.detail}` };
    if (goal.state === "failed") return { outcome: "fail", goal, log: `goal failed: ${goal.detail}` };
    const allClientsCompleted =
      options.scenario.players.length > 0 &&
      options.scenario.players.every((player) => options.clients.completions.has(player.name));
    if (allClientsCompleted) {
      // `goal` above was measured before the clients finished: its completion
      // child reads the map synchronously while its sibling checks are still
      // out on rcon, so a client that reports inside that window is invisible
      // to it and visible here. Every client is now done and nothing further
      // will move, so one more evaluation settles the trial on what actually
      // happened rather than on a snapshot the race already invalidated.
      const settled = await evaluateGoal(options.scenario.goal, context);
      options.onGoalProgress?.(settled);
      if (settled.state === "passed") {
        return { outcome: "pass", goal: settled, log: `goal satisfied: ${settled.detail}` };
      }
      return {
        outcome: "fail",
        goal: settled,
        log: `goal not satisfied on client completion: ${settled.detail}`,
      };
    }
    if (Date.now() > deadline) {
      return { outcome: "timeout", goal, log: `goal not satisfied within ${timeout}s: ${goal.detail}` };
    }
    await delay(GOAL_POLL_MS);
  }
}

async function stopScenarioClients(clients: TrialClientState): Promise<void> {
  await Promise.all([...clients.processes.values()].map((client) => client.stop("scenario finished")));
}

/**
 * Park a copy of the pristine arena before the scenario touches it.
 *
 * Only reused servers need this. An isolated trial gets a world that is deleted
 * the moment it finishes, so there is nothing for the next trial to inherit.
 *
 * Returns the snapshot that was actually taken, or null when it could not be.
 * The distinction matters more than it looks: a restore run from a copy that
 * was never made would clone whatever happens to sit in the scratch region —
 * air, or unrelated terrain — straight over the arena. Never restore from a
 * null.
 */
async function snapshotArena(
  server: MinecraftServer,
  scenario: Scenario,
  log: (message: string) => void,
): Promise<ArenaSnapshot> {
  if (!server.rcon) throw new Error("rcon unavailable before arena snapshot");
  const { snapshot } = compileScenario(scenario);
  if (!snapshot) throw new Error("Reused scenarios need absolute arena coordinates; use an isolated server for an undeclared arena");
  const pinned = await pinRegions(server.rcon, snapshot.pin, log);
  if (!pinned) throw new Error("Arena exceeds the force-load limit; use an isolated server for this scenario");
  try {
    for (const command of snapshot.save) {
      await server.rcon.executeChecked(command, { acceptedNoOp: acceptedNoOp(command) });
    }
    return snapshot;
  } finally {
    await unpinRegions(server.rcon, snapshot.pin);
  }
}

/** Restore the arena after clients stop. A failed restore must stop server reuse. */
async function clearScenario(
  server: MinecraftServer,
  scenario: Scenario,
  backup: ArenaSnapshot,
  log: (message: string) => void,
): Promise<void> {
  if (!server.rcon) throw new Error("rcon unavailable during arena restore");
  // A still-running scenario tick can replace blocks immediately after clone.
  await writeDatapack({ ...scenario, tick: [] }, server.worldDir);
  await server.rcon.executeChecked("reload");
  const { teardown } = compileScenario(scenario);
  const pinned = await pinRegions(server.rcon, backup.pin, log);
  if (!pinned) throw new Error("Arena cannot be pinned for restore; refusing to reuse the dirty world");
  const failures: unknown[] = [];
  try {
    for (const command of [...teardown, ...backup.restore]) {
      try {
        await server.rcon.executeChecked(command, { acceptedNoOp: acceptedNoOp(command) });
      } catch (error) {
        // Finish the other cleanup commands even when one reset command fails.
        failures.push(error);
        log("teardown failed: " + command + " → " + (error instanceof Error ? error.message : String(error)));
      }
    }
  } finally {
    await unpinRegions(server.rcon, backup.pin);
  }
  if (failures.length) throw new AggregateError(failures, "Arena cleanup failed; refusing to reuse the dirty world");
}

/**
 * Build the fixture. Returns the release of the arena's chunk pin, which the
 * caller holds until the clients have arrived: a player teleported into a
 * far-off arena — the Nether, say — then lands in chunks that are already
 * loaded, rather than in ones the server is still generating around it.
 */
async function arrangeScenario(
  server: MinecraftServer,
  scenario: Scenario,
  log: (message: string) => void,
  reuseServer: boolean,
  holdPreparedWorld = false,
): Promise<() => Promise<void>> {
  const rcon = server.rcon;
  if (!rcon) throw new Error("rcon unavailable before arrangement");
  if (reuseServer) await rcon.command(CLEAR_ENTITIES);
  // A standby's tick commands must not run during setup or the selection wait.
  await writeDatapack(holdPreparedWorld ? { ...scenario, tick: [] } : scenario, server.worldDir);
  await rcon.command("reload");
  const { setup, region } = compileScenario(scenario);
  const regions = region ? [region] : [];
  const pinned = await pinRegions(rcon, regions, log);
  const release = async (): Promise<void> => {
    if (pinned) await unpinRegions(rcon, regions);
  };
  try {
    // Chunks must load first; then no redstone, fluid, or scheduled block tick
    // can advance between the first setup command and the start boundary.
    if (holdPreparedWorld) await rcon.executeChecked("tick freeze");
    for (const command of setup) {
      await rcon.executeChecked(command, { acceptedNoOp: acceptedNoOp(command) });
    }
  } catch (error) {
    await release();
    throw error;
  }
  await delay(1500);
  return release;
}

/** Spawn the scenario's live entities only after every client is prepared. */
async function activateScenario(server: MinecraftServer, scenario: Scenario, deferredTick: boolean): Promise<void> {
  if (!server.rcon) throw new Error("rcon unavailable before activation");
  if (deferredTick && scenario.tick.length) {
    await writeDatapack(scenario, server.worldDir);
    await server.rcon.executeChecked("reload");
  }
  const { activation } = compileScenario(scenario);
  for (const command of activation) {
    await server.rcon.executeChecked(command, { acceptedNoOp: acceptedNoOp(command) });
  }
}

/**
 * Force-load the regions a block command is about to name, so it is not refused
 * for naming chunks the world has not loaded. `compileScenario` works out which
 * regions those are; this just pins them.
 *
 * All-or-nothing on purpose. Vanilla caps how many chunks it will hold, and a
 * snapshot needs both the arena and its scratch copy pinned at once — pinning
 * only the half that fits would let a `clone` read or write unloaded chunks,
 * which is worse than not trying.
 */
async function pinRegions(
  rcon: NonNullable<MinecraftServer["rcon"]>,
  regions: readonly SetupRegion[],
  log: (message: string) => void,
): Promise<boolean> {
  const chunks = regions.reduce((total, region) => total + region.chunks, 0);
  if (chunks === 0) return false;
  if (chunks > FORCELOAD_CHUNK_LIMIT) {
    log(`arena spans ${chunks} chunks, above the ${FORCELOAD_CHUNK_LIMIT} Minecraft will pin; leaving it to the server`);
    return false;
  }
  for (const region of regions) {
    await rcon.command(pinRegionCommand(region));
  }
  // Forceload marks the chunks; the server still loads them on later ticks,
  // and a generated arena far from spawn can take a while to appear.
  const deadline = Date.now() + REGION_LOAD_TIMEOUT_MS;
  for (const region of regions) {
    for (const probe of regionLoadedProbes(region)) {
      while (UNLOADED_POSITION.test(await rcon.command(probe))) {
        if (Date.now() > deadline) {
          throw new Error(`arena chunks in ${region.dimension} did not load within ${REGION_LOAD_TIMEOUT_MS / 1000}s`);
        }
        await delay(100);
      }
    }
  }
  return true;
}

const REGION_LOAD_TIMEOUT_MS = 30_000;

/** Release what `pinRegions` pinned, in every dimension it pinned. */
async function unpinRegions(rcon: NonNullable<MinecraftServer["rcon"]>, regions: readonly SetupRegion[]): Promise<void> {
  for (const command of unpinCommands(regions)) await rcon.command(command);
}

async function waitForClientPhase(
  phase: Promise<void>,
  signal: AbortSignal | undefined,
  cancellationMessage: string,
): Promise<void> {
  if (!signal) return phase;
  if (signal.aborted) throw new Error(cancellationMessage);
  const cancelled = Promise.withResolvers<never>();
  const onAbort = (): void => cancelled.reject(new Error(cancellationMessage));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([phase, cancelled.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function waitForPlayer(server: MinecraftServer, name: string, signal: AbortSignal | undefined): Promise<void> {
  if (!server.rcon) throw new Error("rcon unavailable while waiting for a client player");
  const deadline = Date.now() + 5_000;
  while (!(await server.rcon.playerOnline(name))) {
    if (signal?.aborted) throw new Error("trial cancelled before the client player joined");
    if (Date.now() >= deadline) throw new Error(`client '${name}' reported ready but its player did not join the server`);
    await delay(50);
  }
}

async function waitForSpectator(
  server: MinecraftServer,
  clientPlayerCount: number,
  log: (message: string) => void,
  signal?: AbortSignal,
  username?: string,
): Promise<void> {
  if (!server.rcon) throw new Error("rcon unavailable while waiting for spectator");
  log(`waiting for spectator on 127.0.0.1:${server.gamePort}…`);
  let waitedForJoin = false;
  for (;;) {
    if (signal?.aborted) throw new Error("trial cancelled before spectator connected");
    const joined = username
      ? await server.rcon.playerOnline(username)
      : Number((await server.rcon.command("list")).match(/\d+/u)?.[0] ?? 0) > clientPlayerCount;
    if (joined) break;
    waitedForJoin = true;
    await delay(username ? 100 : 1000, signal);
  }
  if (signal?.aborted) throw new Error("trial cancelled before spectator connected");
  if (waitedForJoin && !username) {
    log("spectator joined — starting in 3s");
    await delay(3000, signal);
  }
  if (signal?.aborted) throw new Error("trial cancelled before spectator connected");
}

function emptyResult(scenario: Scenario, startedAt: number): RunResult {
  return {
    ...(scenario.verification && scenario.world.seed !== undefined ? {
      verification: { seed: scenario.world.seed, players: scenario.players, radius: scenario.verification.radius },
    } : {}),
    scenario: scenario.name ?? "scenario",
    outcome: "fail",
    elapsedMs: Date.now() - startedAt,
    goal: { state: "pending", detail: "not run" },
    goalText: describeGoal(scenario.goal),
  };
}
