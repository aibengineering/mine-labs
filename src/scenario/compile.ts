/**
 * Translate a validated scenario into the Minecraft commands that build it.
 *
 * This is the only module that needs to know how vanilla actually behaves: what
 * a `fill` says when it filled nothing, that a freshly generated world has only
 * its spawn chunks loaded, that command feedback echoes into the log unless a
 * gamerule stops it. Keeping that knowledge here means the trial runner can
 * stay a runner — it executes what it is handed and judges the result, without
 * also being the place that knows Minecraft's grammar.
 *
 * A scenario is declarative, so compilation is a pure function of the scenario:
 * the same scenario always produces the same commands, in the same order, and
 * is fully inspectable in a test without a server.
 */

import { join } from "node:path";
import type { Dimension, Scenario } from "./schema.js";
import { posToCommand } from "./schema.js";
import { writeTextFile } from "../util/fs.js";
import { commandVerb, inDimension, resourceId, withoutDimension } from "../util/minecraft.js";

export interface CompiledScenario {
  /** One-shot commands run over rcon after world load, before client players join. */
  setup: string[];
  /** Entities spawned after every client has observed its arranged player state. */
  activation: string[];
  /**
   * Commands that return the world to how the scenario found it, run once the
   * scenario is done. Always clears non-player entities; a scenario that
   * declares its own `reset` gets those additional commands replayed too.
   *
   * Client block changes are restored separately — see `snapshot`.
   */
  teardown: string[];
  /**
   * The box the scenario declares: everything its geometry, entities and
   * players occupy, widened by a margin for the room a client actually moves
   * and digs in. The runner force-loads this before setup (see `setupRegion`)
   * and snapshots it when the server is reused.
   *
   * Null when the scenario names no absolute coordinates at all.
   */
  region: SetupRegion | null;
  /**
   * How to save and restore `region` verbatim, or null when that is not
   * possible because no absolute arena coordinates are declared.
   *
   * This is what makes a reused server actually reset. See `arenaSnapshot`.
   */
  snapshot: ArenaSnapshot | null;
}

/** A block box in one dimension, plus the number of chunk columns it covers. */
export interface SetupRegion {
  /** `forceload` and `clone` are per dimension, so a region carries its own. */
  dimension: Dimension;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  /** Chunks the region spans, which decides whether Minecraft will pin it. */
  chunks: number;
}

/**
 * A copy of the pristine arena, parked elsewhere in the same world.
 *
 * Vanilla has no command that regenerates terrain, so the only way to hand the
 * next trial an untouched arena is to have kept a copy of it. `save` runs
 * before setup — while the arena is still pristine — and `restore` runs after
 * the trial, putting every block back exactly as it was, whatever the clients
 * did to it. This works identically for a superflat sandbox and for real
 * generated terrain, and needs no knowledge of how the world was generated.
 */
export interface ArenaSnapshot {
  /** Copy the pristine arena into the scratch region. Runs before setup. */
  save: string[];
  /** Copy it back over the dirtied arena. Runs at teardown. */
  restore: string[];
  /** Every region that must be force-loaded for `save`/`restore` to work. */
  pin: SetupRegion[];
}

/** Chunks vanilla will hold with `forceload add`. Beyond this it refuses the command. */
export const FORCELOAD_CHUNK_LIMIT = 256;

/**
 * Killing everything the scenario summoned. Safe to run unconditionally: it
 * needs no declared region and cannot touch a block, so unlike the rest of
 * teardown there is never a reason to skip it.
 */
export const CLEAR_ENTITIES = "kill @e[type=!minecraft:player]";

/**
 * Pin one region's chunks. `forceload` is per dimension: run bare over rcon
 * it marks overworld chunks, which does nothing for an arena in the Nether.
 */
export function pinRegionCommand(region: SetupRegion): string {
  return inDimension(region.dimension, `forceload add ${region.minX} ${region.minZ} ${region.maxX} ${region.maxZ}`);
}

/**
 * Block queries that tell a pinned region's corners apart from unloaded
 * chunks. `forceload add` only marks chunks; the server generates and loads
 * them on later ticks, and a fresh arena far from spawn — a Nether fortress,
 * say — can take seconds. A `fill` issued before then is refused as not
 * loaded, so the runner polls these until none of them says so.
 */
export function regionLoadedProbes(region: SetupRegion): string[] {
  const corners = [
    [region.minX, region.minZ],
    [region.minX, region.maxZ],
    [region.maxX, region.minZ],
    [region.maxX, region.maxZ],
  ];
  return corners.map(([x, z]) => inDimension(region.dimension, `execute if block ${x} ${region.minY} ${z} minecraft:air`));
}

/** What vanilla says to a block query in a chunk it has not loaded. */
export const UNLOADED_POSITION = /not loaded/iu;

/** Release every pin, once per dimension the regions were pinned in. */
export function unpinCommands(regions: readonly SetupRegion[]): string[] {
  const dimensions = [...new Set(regions.map((region) => region.dimension))];
  return dimensions.map((dimension) => inDimension(dimension, "forceload remove all"));
}

// How far past the declared blocks the arena reaches. A scenario names the
// fixture it builds, not the space its clients move through: a bot jumps,
// towers up, digs down and strays past the edge of the floor it was given.
// Restoring only the declared blocks would leave exactly that damage behind,
// so the arena is widened before anything is snapshotted.
const ARENA_MARGIN = 8;
const ARENA_HEADROOM = 16;
const ARENA_UNDERCUT = 4;

// Build limits per dimension. The arena is clamped to these because `clone`
// fails outright on a box that leaves the world, and a scenario built near
// bedrock would otherwise push the undercut below it.
const BUILD_LIMITS: Record<Dimension, { minY: number; maxY: number }> = {
  overworld: { minY: -64, maxY: 319 },
  the_nether: { minY: 0, maxY: 255 },
  the_end: { minY: 0, maxY: 255 },
};

// Where the pristine copy is parked, as a gap between the arena and its
// backup. `clone` refuses a source and destination that overlap, and the gap
// is added to the arena's own width so they cannot, at any arena size.
const SCRATCH_GAP = 512;


// Scenario arenas can exceed vanilla's 32,768-block /fill ceiling. Setup and
// teardown happen outside the measured trial, so allow one command to cover a
// complete fixture rather than silently leaving part of the arena behind.
const ALLOW_LARGE_FIXTURE_COMMANDS = "gamerule commandModificationBlockLimit 1000000";

// Mine Labs issues a lot of rcon traffic per trial — every setup command, every
// query the goal/metrics machinery makes via `execute store ...`, every
// operator-watch poll. With feedback on, each one echoes into the server log
// and broadcasts to nearby ops in chat, which drowns out everything else. The
// rcon connection that issued a command still gets its own response text
// regardless of this gamerule — only the broadcast-to-others-and-log is what
// it silences — so this does not affect anything `Rcon` reads back.
const QUIET_COMMAND_FEEDBACK = "gamerule sendCommandFeedback false";

/**
 * Turn a scenario into world-mutation commands:
 * - geometry/setup → rcon setup commands (runs once, right after boot)
 * - entities → rcon activation commands (runs after clients are prepared)
 * - scenario.tick → a datapack with a `#minecraft:tick` function so commands
 *   fire reliably every tick (rcon spam would starve the server loop)
 */
export function compileScenario(s: Scenario): CompiledScenario {
  // Everything a scenario places is in its arena dimension. Rcon runs in the
  // overworld, so each world edit is pointed at the arena; the server-wide
  // settings between them (gamerules, time, difficulty) have no dimension.
  const arena = (command: string): string => inDimension(s.world.dimension, command);
  const setup: string[] = [QUIET_COMMAND_FEEDBACK, ALLOW_LARGE_FIXTURE_COMMANDS, ...s.reset.map(arena)];

  for (const g of s.geometry) {
    if ("fill" in g) {
      const { block, from, to, mode } = g.fill;
      setup.push(arena(`fill ${posToCommand(from)} ${posToCommand(to)} ${block}${mode ? ` ${mode}` : ""}`));
    } else if ("setblock" in g) {
      setup.push(arena(`setblock ${posToCommand(g.setblock.at)} ${g.setblock.block}`));
    } else {
      setup.push(arena(g.run));
    }
  }

  const activation = s.entities.map((entity) =>
    arena(`summon ${resourceId(entity.type)} ${posToCommand(entity.pos)} ${entity.nbt ?? ""}`.trim()),
  );

  if (s.world.spawn) setup.push(`setworldspawn ${posToCommand(s.world.spawn)}`);
  setup.push(`time set ${s.world.time}`);
  if (s.world.difficulty) setup.push(`difficulty ${s.world.difficulty}`);
  for (const [rule, value] of Object.entries(s.world.gamerules)) {
    setup.push(`gamerule ${rule} ${value}`);
  }
  // Superflat worlds spawn slimes constantly; scenarios declare their own
  // entities, so silence natural spawns unless the scenario opts in.
  if (s.world.type === "flat" && !("doMobSpawning" in s.world.gamerules)) {
    setup.push("gamerule doMobSpawning false");
  }
  setup.push(...s.setup.map(arena));

  // Entities first: the reset clears blocks, and anything the scenario summoned
  // would otherwise be left standing in the cleared space.
  const teardown =
    s.reset.length > 0
      ? [ALLOW_LARGE_FIXTURE_COMMANDS, CLEAR_ENTITIES, ...s.reset.map(arena)]
      : [ALLOW_LARGE_FIXTURE_COMMANDS, CLEAR_ENTITIES];

  const region = setupRegion([...setup, ...activation], s);
  // Authored reset commands cannot account for blocks placed or dug by clients.
  // Every reusable arena still needs its pristine block snapshot.
  const snapshot = arenaSnapshot(region);

  return { setup, activation, teardown, region, snapshot };
}

/**
 * Build the save/restore pair for an arena, or null when there is nothing to
 * snapshot.
 *
 * `clone` is the whole trick. It copies a box of blocks from one place in a
 * loaded world to another, exactly, including block entities, and without
 * caring whether those blocks came from a superflat preset or real terrain
 * generation. That is why this needs no `world.type` branch: reconstructing a
 * flat world by re-filling its known layers would work only for flat worlds,
 * and only for as long as nobody changed the preset.
 *
 * Both commands re-raise the block limit themselves. `save` runs before the
 * setup list, so it cannot rely on the gamerule that list sets, and a 32,768
 * block default would silently truncate the copy of a large arena.
 */
function arenaSnapshot(region: SetupRegion | null): ArenaSnapshot | null {
  if (!region) return null;
  const scratch = scratchRegion(region);
  // Snapshot the actual expanded arena, which can exceed the setup fill size.
  const volume = (region.maxX - region.minX + 1) * (region.maxY - region.minY + 1) * (region.maxZ - region.minZ + 1);
  const allowSnapshot = `gamerule commandModificationBlockLimit ${Math.max(1000000, volume)}`;
  const arenaBox = `${region.minX} ${region.minY} ${region.minZ} ${region.maxX} ${region.maxY} ${region.maxZ}`;
  const scratchBox = `${scratch.minX} ${scratch.minY} ${scratch.minZ} ${scratch.maxX} ${scratch.maxY} ${scratch.maxZ}`;
  return {
    save: [allowSnapshot, inDimension(region.dimension, `clone ${arenaBox} ${scratch.minX} ${scratch.minY} ${scratch.minZ}`)],
    restore: [allowSnapshot, inDimension(region.dimension, `clone ${scratchBox} ${region.minX} ${region.minY} ${region.minZ}`)],
    pin: [region, scratch],
  };
}

/**
 * Where an arena's pristine copy lives: the same box, shifted along X.
 *
 * The shift is the arena's own width plus a fixed gap, so source and
 * destination can never overlap however large the arena is — `clone` rejects
 * an overlapping pair outright. Y is left alone so the copy cannot be pushed
 * outside the world's build limits by the shift.
 */
function scratchRegion(region: SetupRegion): SetupRegion {
  const offset = region.maxX - region.minX + SCRATCH_GAP;
  const minX = region.minX + offset;
  const maxX = region.maxX + offset;
  return { ...region, minX, maxX, chunks: chunkSpan(minX, region.minZ, maxX, region.maxZ) };
}

/** Chunk columns a horizontal span covers, which is what `forceload` counts. */
function chunkSpan(minX: number, minZ: number, maxX: number, maxZ: number): number {
  return (
    (Math.floor(maxX / 16) - Math.floor(minX / 16) + 1) *
    (Math.floor(maxZ / 16) - Math.floor(minZ / 16) + 1)
  );
}

/**
 * Whether Minecraft reporting "nothing happened" counts as this command working.
 *
 * A command that could not be applied — an unloaded chunk, a coordinate outside
 * the world — is a broken fixture and must fail the trial. A command that found
 * the world already in the state it asked for has done its job: scenario
 * geometry is declarative, and a fixture is allowed to state an invariant that
 * an earlier fill already satisfies. Only the second case is accepted here, and
 * it is accepted for every setup command rather than only the reset block,
 * because geometry is exactly where redundant-but-true statements live.
 */
export function acceptedNoOp(command: string): RegExp | undefined {
  switch (commandVerb(command)) {
    case "fill":
      return /^No blocks were filled$/u;
    case "kill":
      return /^No entity was found$/u;
    case "forceload":
      return /^No chunks were marked for force loading$/u;
    // An arena whose box is entirely air — common for a flat sandbox, where the
    // declared blocks sit under a lot of empty space — copies onto a scratch
    // region that is already air, so nothing changes and vanilla calls that a
    // failure. There is genuinely nothing to restore, which is not an error.
    case "clone":
      return /^No blocks were cloned$/u;
    case "difficulty":
      return /^The difficulty did not change; it is already set to \w+$/u;
    // A `data merge` that finds the block or entity already in the declared
    // state is an invariant that holds, not a fixture that failed to build.
    case "data":
      return /^Nothing changed/u;
    default:
      return undefined;
  }
}

/**
 * The box a scenario occupies, widened into the space its clients will use.
 *
 * Two jobs, and they want the same answer. A freshly generated world has only
 * its spawn chunks loaded and `fill` refuses a region that is not loaded, so
 * the runner has to pin this before setup runs — that is what makes a
 * scenario's declared bounds mean the same thing however far from spawn they
 * sit. The snapshot then needs the same box, because the space worth restoring
 * is exactly the space the scenario is allowed to dirty.
 *
 * Everything the scenario names is folded in, not just its blocks: a `summon`
 * puts a mob somewhere, `setworldspawn` and each player's `pos` put a client
 * somewhere, and all of them are places a trial happens. The beacon-walk
 * example is the case in point — its only declared block is the target at
 * x=12, while its player starts at x=0, so a blocks-only scan would pin and
 * restore an arena that does not contain the walk.
 */
function setupRegion(setup: readonly string[], scenario: Scenario): SetupRegion | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  const fold = (triple: readonly string[]): void => {
    if (triple.length !== 3) return;
    const coordinates = triple.map(Number);
    if (!coordinates.every(Number.isFinite)) return;
    const [x, y, z] = coordinates.map(Math.floor);
    // Relative and local coordinates resolve against the command's executor,
    // which rcon does not place in the world, so only absolutes are folded in.
    minX = Math.min(minX, x!);
    maxX = Math.max(maxX, x!);
    minY = Math.min(minY, y!);
    maxY = Math.max(maxY, y!);
    minZ = Math.min(minZ, z!);
    maxZ = Math.max(maxZ, z!);
  };

  for (const command of setup) {
    // Compiled commands already carry the arena dimension; read through it.
    const parts = withoutDimension(command).split(/\s+/u);
    switch (parts[0]) {
      case "fill":
        fold(parts.slice(1, 4));
        fold(parts.slice(4, 7));
        break;
      case "setblock":
      case "setworldspawn":
        fold(parts.slice(1, 4));
        break;
      // `summon <entity> <x> <y> <z>` — the position starts one word later.
      case "summon":
        fold(parts.slice(2, 5));
        break;
      default:
        break;
    }
  }
  for (const player of scenario.players) {
    // A player position may be raw command coordinates rather than a tuple, so
    // it is split the same way a command is; `fold` then drops it if it turns
    // out to be relative.
    if (player.pos) fold(posToCommand(player.pos).split(/\s+/u));
  }

  if (!Number.isFinite(minX)) return null;

  // Widen to the space a client actually uses, then clamp: `clone` fails on a
  // box that leaves the world, and an arena built near bedrock would otherwise
  // push its undercut below it.
  minX -= ARENA_MARGIN;
  maxX += ARENA_MARGIN;
  minZ -= ARENA_MARGIN;
  maxZ += ARENA_MARGIN;
  const { dimension } = scenario.world;
  minY = Math.max(BUILD_LIMITS[dimension].minY, minY - ARENA_UNDERCUT);
  maxY = Math.min(BUILD_LIMITS[dimension].maxY, maxY + ARENA_HEADROOM);

  return { dimension, minX, minY, minZ, maxX, maxY, maxZ, chunks: chunkSpan(minX, minZ, maxX, maxZ) };
}

/** Write the tick datapack into <worldDir>/datapacks if the scenario has tick commands. */
export async function writeDatapack(s: Scenario, worldDir: string): Promise<void> {
  const ns = "mine_labs_scenario";
  const root = join(worldDir, "datapacks", ns);
  await writeTextFile(
    join(root, "pack.mcmeta"),
    JSON.stringify({ pack: { pack_format: 61, description: "mine-labs scenario tick loop" } }, null, 2),
  );
  // A tick function runs in the overworld like rcon does, so each command is
  // pointed at the arena the same way.
  await writeTextFile(
    join(root, "data", ns, "function", "tick.mcfunction"),
    s.tick.map((command) => inDimension(s.world.dimension, command)).join("\n") + "\n",
  );
  // Register the tick function via the vanilla tick tag.
  await writeTextFile(
    join(root, "data", "minecraft", "tags", "function", "tick.json"),
    JSON.stringify({ values: [`${ns}:tick`] }, null, 2),
  );
}
