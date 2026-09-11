import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acceptedNoOp, compileScenario, pinRegionCommand, regionLoadedProbes, unpinCommands, writeDatapack, UNLOADED_POSITION } from "./compile.js";
import { scenarioSchema } from "./schema.js";

test("large fixture commands are enabled before reset and scenario geometry", () => {
  const scenario = scenarioSchema.parse({
    name: "resettable",
    client: { command: "test-client" },
    reset: ["fill -8 -59 -8 8 -40 8 air"],
    geometry: [{ setblock: { block: "stone", at: [0, -59, 0] } }],
    goal: { kind: "survive", seconds: 1 },
  });

  assert.deepEqual(compileScenario(scenario).setup.slice(0, 4), [
    "gamerule sendCommandFeedback false",
    "gamerule commandModificationBlockLimit 1000000",
    "fill -8 -59 -8 8 -40 8 air",
    "setblock 0 -59 0 stone",
  ]);
});

test("declared entities activate only after player preparation", () => {
  const scenario = scenarioSchema.parse({
    name: "hostile-start",
    client: { command: "test-client" },
    entities: [{ type: "zombie", pos: [1, -59, 1], nbt: "{PersistenceRequired:1b}" }],
    goal: { kind: "survive", seconds: 1 },
  });

  const compiled = compileScenario(scenario);
  assert.equal(compiled.setup.some((command) => command.startsWith("summon ")), false);
  assert.deepEqual(compiled.activation, [
    "summon minecraft:zombie 1 -59 1 {PersistenceRequired:1b}",
  ]);
});

test("a scenario's reset is replayed on the way out, entities first", () => {
  const scenario = scenarioSchema.parse({
    name: "dirty",
    client: { command: "test-client" },
    reset: ["fill -8 -59 -8 8 -40 8 air"],
    geometry: [{ setblock: { block: "stone", at: [0, -59, 0] } }],
    entities: [{ type: "zombie", pos: [1, -59, 1] }],
    goal: { kind: "survive", seconds: 1 },
  });

  assert.deepEqual(compileScenario(scenario).teardown, [
    "gamerule commandModificationBlockLimit 1000000",
    "kill @e[type=!minecraft:player]",
    "fill -8 -59 -8 8 -40 8 air",
  ]);
});

test("a scenario that declares no reset still clears its entities", () => {
  const scenario = scenarioSchema.parse({
    name: "clean",
    client: { command: "test-client" },
    goal: { kind: "survive", seconds: 1 },
  });
  // Nothing here names a coordinate, so there is no arena to snapshot — but
  // killing what the scenario summoned needs no region and always applies.
  const { teardown, region, snapshot } = compileScenario(scenario);
  assert.deepEqual(teardown, [
    "gamerule commandModificationBlockLimit 1000000",
    "kill @e[type=!minecraft:player]",
  ]);
  assert.equal(region, null);
  assert.equal(snapshot, null);
});

test("an arena covers where the players start, not just where the blocks are", () => {
  // The beacon-walk shape: the only declared block is the target the client
  // walks to, while the client itself starts twelve blocks away. A scan that
  // only read `setblock` would pin and restore an arena missing the walk.
  const scenario = scenarioSchema.parse({
    name: "beacon",
    client: { command: "test-client" },
    geometry: [{ setblock: { block: "gold_block", at: [12, -60, 12] } }],
    players: [{ name: "rover", pos: [0, -59, 0] }],
    goal: { kind: "survive", seconds: 1 },
  });

  const { region } = compileScenario(scenario);
  assert.ok(region);
  // x/z span both endpoints plus the 8-block margin; y is clamped down to the
  // world floor by the undercut and reaches 16 above the highest block.
  assert.deepEqual(region, { dimension: "overworld", minX: -8, minY: -64, minZ: -8, maxX: 20, maxY: -43, maxZ: 20, chunks: 9 });
});

test("an arena with no declared reset is snapshotted and restored verbatim", () => {
  const scenario = scenarioSchema.parse({
    name: "sandbox",
    client: { command: "test-client" },
    geometry: [{ setblock: { block: "gold_block", at: [12, -60, 12] } }],
    players: [{ name: "rover", pos: [0, -59, 0] }],
    goal: { kind: "survive", seconds: 1 },
  });

  const { snapshot } = compileScenario(scenario);
  assert.ok(snapshot);
  // Both halves raise the block limit themselves: `save` runs before the setup
  // list, so it cannot rely on the gamerule that list sets.
  assert.deepEqual(snapshot.save, [
    "gamerule commandModificationBlockLimit 1000000",
    "clone -8 -64 -8 20 -43 20 532 -64 -8",
  ]);
  assert.deepEqual(snapshot.restore, [
    "gamerule commandModificationBlockLimit 1000000",
    "clone 532 -64 -8 560 -43 20 -8 -64 -8",
  ]);
});

test("the scratch copy never overlaps the arena it backs up", () => {
  // `clone` rejects an overlapping source and destination outright, so the
  // offset has to beat the arena's own width at any size.
  for (const half of [1, 40, 400]) {
    const scenario = scenarioSchema.parse({
      name: `wide-${half}`,
      client: { command: "test-client" },
      geometry: [{ fill: { block: "stone", from: [-half, -60, -half], to: [half, -60, half] } }],
      goal: { kind: "survive", seconds: 1 },
    });
    const { region, snapshot } = compileScenario(scenario);
    assert.ok(region && snapshot);
    const [, scratch] = snapshot.pin;
    assert.ok(scratch);
    assert.ok(scratch.minX > region.maxX, `scratch overlaps arena at half-width ${half}`);
  }
});

test("an explicit reset still snapshots client block changes", () => {
  const scenario = scenarioSchema.parse({
    name: "self-cleaning",
    client: { command: "test-client" },
    reset: ["fill -8 -59 -8 8 -40 8 air"],
    geometry: [{ setblock: { block: "stone", at: [0, -59, 0] } }],
    goal: { kind: "survive", seconds: 1 },
  });
  assert.ok(compileScenario(scenario).snapshot);
});

test("entity-only resets and fractional player coordinates retain a restorable arena", () => {
  const scenario = scenarioSchema.parse({
    name: "fractional-arena", client: { command: "test-client" },
    reset: ["kill @e[type=!minecraft:player]"],
    players: [{ name: "Builder", pos: [-0.5, -60, 0.5] }],
    goal: { kind: "completion", who: "Builder" },
  });
  const compiled = compileScenario(scenario);
  assert.ok(compiled.snapshot);
  assert.equal(compiled.region?.minX, -9);
  assert.equal(compiled.region?.maxX, 7);
  assert.equal(compiled.region?.minZ, -8);
  assert.equal(compiled.region?.maxZ, 8);
});

test("large arenas permit snapshots beyond one million blocks", () => {
  const scenario = scenarioSchema.parse({
    name: "progression-snapshot", client: { command: "test-client" },
    reset: ["fill -64 -64 -64 96 -40 64 air"],
    goal: { kind: "survive", seconds: 1 },
  });
  const { snapshot } = compileScenario(scenario);
  assert.ok(snapshot);
  assert.equal(snapshot.save[0], "gamerule commandModificationBlockLimit 1052265");
  assert.equal(snapshot.restore[0], snapshot.save[0]);
});

test("a Nether scenario points every world edit at the Nether and leaves server settings bare", () => {
  const scenario = scenarioSchema.parse({
    name: "fortress",
    client: { command: "test-client" },
    world: { type: "default", dimension: "the_nether", difficulty: "normal", gamerules: { doMobSpawning: false } },
    reset: ["fill -8 80 -8 8 100 8 air"],
    geometry: [{ setblock: { block: "nether_bricks", at: [0, 82, 0] } }, { run: "/fill 0 83 0 0 85 0 air" }],
    setup: ["execute as @a run effect give @s minecraft:fire_resistance infinite 0 true"],
    entities: [{ type: "blaze", pos: [2, 85, 2] }],
    players: [{ name: "Fighter", pos: [0.5, 82, 0.5] }],
    goal: { kind: "survive", seconds: 1 },
  });

  const compiled = compileScenario(scenario);
  assert.deepEqual(compiled.setup, [
    "gamerule sendCommandFeedback false",
    "gamerule commandModificationBlockLimit 1000000",
    "execute in minecraft:the_nether run fill -8 80 -8 8 100 8 air",
    "execute in minecraft:the_nether run setblock 0 82 0 nether_bricks",
    "execute in minecraft:the_nether run fill 0 83 0 0 85 0 air",
    "time set day",
    "difficulty normal",
    "gamerule doMobSpawning false",
    "execute in minecraft:the_nether as @a run effect give @s minecraft:fire_resistance infinite 0 true",
  ]);
  assert.deepEqual(compiled.activation, ["execute in minecraft:the_nether run summon minecraft:blaze 2 85 2"]);
  assert.deepEqual(compiled.teardown, [
    "gamerule commandModificationBlockLimit 1000000",
    "kill @e[type=!minecraft:player]",
    "execute in minecraft:the_nether run fill -8 80 -8 8 100 8 air",
  ]);
  // The arena is read through the dimension scope and clamped to the Nether's build height.
  assert.equal(compiled.region?.dimension, "the_nether");
  assert.deepEqual(
    [compiled.region?.minX, compiled.region?.minY, compiled.region?.minZ, compiled.region?.maxX, compiled.region?.maxY, compiled.region?.maxZ],
    [-16, 76, -16, 16, 116, 16],
  );
  assert.ok(compiled.snapshot?.save[1]?.startsWith("execute in minecraft:the_nether run clone -16 76 -16 16 116 16 "));
  assert.ok(compiled.snapshot?.restore[1]?.startsWith("execute in minecraft:the_nether run clone "));
  assert.ok(compiled.snapshot?.pin.every((region) => region.dimension === "the_nether"));
  assert.equal(pinRegionCommand(compiled.region!), "execute in minecraft:the_nether run forceload add -16 -16 16 16");
  assert.deepEqual(unpinCommands(compiled.snapshot!.pin), ["execute in minecraft:the_nether run forceload remove all"]);
  assert.equal(acceptedNoOp("execute in minecraft:the_nether run fill 0 0 0 1 1 1 air")?.test("No blocks were filled"), true);
});

test("an overworld scenario compiles to bare commands, exactly as before dimensions existed", () => {
  const scenario = scenarioSchema.parse({
    name: "flat",
    client: { command: "test-client" },
    geometry: [{ fill: { block: "stone", from: [-2, -60, -2], to: [2, -60, 2] } }],
    entities: [{ type: "zombie", pos: [1, -59, 1] }],
    goal: { kind: "survive", seconds: 1 },
  });
  const compiled = compileScenario(scenario);
  assert.ok(compiled.setup.includes("fill -2 -60 -2 2 -60 2 stone"));
  assert.deepEqual(compiled.activation, ["summon minecraft:zombie 1 -59 1"]);
  assert.equal(compiled.region?.dimension, "overworld");
  assert.equal(pinRegionCommand(compiled.region!), "forceload add -10 -10 10 10");
  assert.deepEqual(unpinCommands(compiled.snapshot!.pin), ["forceload remove all"]);
});

test("tick commands run in the arena dimension", async () => {
  const worldDir = await mkdtemp(join(tmpdir(), "mine-labs-datapack-"));
  const scenario = scenarioSchema.parse({
    client: { command: "test-client" },
    world: { dimension: "the_end" },
    players: [{ name: "Runner", pos: [0, 60, 0] }],
    tick: ["kill @e[type=minecraft:item]"],
    goal: { kind: "survive", seconds: 1 },
  });
  await writeDatapack(scenario, worldDir);
  const written = await readFile(
    join(worldDir, "datapacks", "mine_labs_scenario", "data", "mine_labs_scenario", "function", "tick.mcfunction"),
    "utf8",
  );
  assert.equal(written, "execute in minecraft:the_end run kill @e[type=minecraft:item]\n");
});

test("a pinned region is probed at its corners, in its own dimension, before setup runs", () => {
  const scenario = scenarioSchema.parse({
    client: { command: "test-client" },
    world: { type: "default", dimension: "the_nether" },
    players: [{ name: "Runner", pos: [0.5, 82, 0.5] }],
    setup: ["data merge block -28 82 357 {SpawnCount:0s}"],
    goal: { kind: "survive", seconds: 1 },
  });
  const { region } = compileScenario(scenario);
  assert.deepEqual(regionLoadedProbes(region!), [
    "execute in minecraft:the_nether if block -8 78 -8 minecraft:air",
    "execute in minecraft:the_nether if block -8 78 8 minecraft:air",
    "execute in minecraft:the_nether if block 8 78 -8 minecraft:air",
    "execute in minecraft:the_nether if block 8 78 8 minecraft:air",
  ]);
  assert.ok(UNLOADED_POSITION.test("That position is not loaded"));
  assert.ok(!UNLOADED_POSITION.test("Test passed"));
  assert.equal(acceptedNoOp("data merge block -28 82 357 {SpawnCount:0s}")?.test("Nothing changed. The specified properties already have these values"), true);
});
