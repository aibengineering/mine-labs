import assert from "node:assert/strict";
import test from "node:test";
import {
  scenarioSchema,
  scenarioTemplateSchema,
  type Scenario,
  type ScenarioInput,
} from "./schema.js";

test("scenario parsing turns optional input into a complete runner scenario", () => {
  const input: ScenarioInput = {
    client: { command: "test-client" },
    goal: { kind: "completion" },
  };

  const scenario: Scenario = scenarioSchema.parse(input);

  assert.deepEqual(scenario.minecraft, { version: "1.21.4" });
  assert.deepEqual(scenario.world, { type: "flat", dimension: "overworld", structures: false, time: "day", gamerules: {} });
  assert.deepEqual(scenario.players, [{ name: "player1", inventory: [], op: false }]);
  assert.deepEqual(scenario.client, { command: "test-client", args: [], env: {} });
});

test("template parsing leaves absent scenario fields absent", () => {
  assert.deepEqual(scenarioTemplateSchema.parse({}), {});
});

test("client environment values are explicit strings", () => {
  const accepted = scenarioSchema.safeParse({
    client: { command: "test-client", env: { COMBAT_IMPLEMENTATION: "baseline" } },
    goal: { kind: "completion" },
  });
  const rejected = scenarioSchema.safeParse({
    client: { command: "test-client", env: { ATTEMPT: 1 } },
    goal: { kind: "completion" },
  });

  assert.equal(accepted.success, true);
  assert.equal(rejected.success, false);
});

test("scenario objects reject unknown fields instead of silently discarding them", () => {
  const result = scenarioSchema.safeParse({
    client: { command: "test-client" },
    goal: { kind: "completion", typo: true },
    unexpectedTopLevel: true,
  });

  assert.equal(result.success, false);
  if (!result.success) assert.match(result.error.message, /unrecognized_keys/u);
});

test("one geometry entry cannot contain multiple world operations", () => {
  const result = scenarioSchema.safeParse({
    client: { command: "test-client" },
    geometry: [{
      fill: { block: "stone", from: [0, 0, 0], to: [1, 1, 1] },
      setblock: { block: "dirt", at: [0, 0, 0] },
    }],
    goal: { kind: "completion" },
  });

  assert.equal(result.success, false);
});

test("timeout belongs to the complete goal rather than a nested condition", () => {
  const result = scenarioSchema.safeParse({
    client: { command: "test-client" },
    goal: {
      kind: "all",
      timeout: 30,
      goals: [{ kind: "completion", timeout: 5 }],
    },
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((issue) =>
      issue.code === "unrecognized_keys"
      && issue.path.join(".") === "goal.goals.0"
      && issue.keys.includes("timeout")
    ));
  }
});

test("who attributes leaf goals but is rejected on composite goals", () => {
  const leaf = scenarioSchema.safeParse({
    client: { command: "test-client" },
    players: [{ name: "Collector" }],
    goal: { kind: "blockAt", who: "Collector", pos: [0, 0, 0], block: "stone" },
  });
  const composite = scenarioSchema.safeParse({
    client: { command: "test-client" },
    players: [{ name: "Collector" }],
    goal: {
      kind: "all",
      who: "Collector",
      goals: [{ kind: "completion", who: "Collector" }],
    },
  });

  assert.equal(leaf.success, true);
  assert.equal(composite.success, false);
});

test("a scenario declares its arena dimension, with or without the namespace", () => {
  const base = { client: { command: "test-client" }, goal: { kind: "completion" as const } };
  assert.equal(scenarioSchema.parse(base).world.dimension, "overworld");
  const nether = scenarioSchema.parse({
    ...base,
    world: { dimension: "minecraft:the_nether" },
    players: [{ name: "Runner", pos: [0, 70, 0] }],
  });
  assert.equal(nether.world.dimension, "the_nether");
  assert.equal(scenarioSchema.safeParse({ ...base, world: { dimension: "the_moon" } }).success, false);
});

test("a scenario outside the overworld must say where each player starts", () => {
  const result = scenarioSchema.safeParse({
    client: { command: "test-client" },
    goal: { kind: "completion" },
    world: { dimension: "the_nether" },
    players: [{ name: "Runner" }],
  });
  assert.equal(result.success, false);
  assert.deepEqual(result.error?.issues.map((issue) => issue.path), [["players", 0, "pos"]]);
});

test("schedule entries need a tick count or a condition, and take one command or a list", () => {
  const base = { client: { command: "test-client" }, goal: { kind: "completion" as const } };
  const parsed = scenarioSchema.parse({ ...base, schedule: [
    { afterTicks: 0, run: "say now" },
    { when: "entity @a[name=Bot,x=2,y=-61,z=-5,dx=40,dy=4,dz=10]", run: ["say a", "say b"] },
    { afterTicks: 40, when: "score #t clock matches 100..", run: "say later" },
  ] });
  assert.equal(parsed.schedule.length, 3);
  assert.deepEqual(scenarioSchema.parse(base).schedule, []);

  const rejected = (schedule: unknown[]): string[] => {
    const result = scenarioSchema.safeParse({ ...base, schedule });
    return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  };
  assert.match(rejected([{ run: "say never" }]).join("\n"), /schedule\.0: a schedule entry needs afterTicks, when, or both/u);
  assert.match(rejected([{ afterTicks: 1.5, run: "say" }]).join("\n"), /schedule\.0\.afterTicks/u);
  assert.match(rejected([{ afterTicks: -1, run: "say" }]).join("\n"), /schedule\.0\.afterTicks/u);
  assert.match(rejected([{ afterTicks: 1, run: [] }]).join("\n"), /schedule\.0\.run/u);
  assert.match(rejected([{ when: "execute if entity @a", run: "say" }]).join("\n"), /follows `execute if`/u);
  assert.match(rejected([{ afterTicks: 1, run: "say", every: 5 }]).join("\n"), /Unrecognized key/iu);
});

test("a player's starting hunger is whole points, saturation within food, and never on peaceful", () => {
  const base = { client: { command: "test-client" }, goal: { kind: "completion" as const } };
  const player = (fields: Record<string, unknown>) => ({ ...base, players: [{ name: "Hungry", ...fields }] });
  assert.deepEqual(
    scenarioSchema.parse(player({ food: 6, saturation: 2 })).players[0],
    { name: "Hungry", inventory: [], op: false, food: 6, saturation: 2 },
  );
  assert.equal(scenarioSchema.safeParse(player({ saturation: 20 })).success, true);
  assert.equal(scenarioSchema.safeParse(player({ food: 21 })).success, false);
  assert.equal(scenarioSchema.safeParse(player({ food: -1 })).success, false);
  assert.equal(scenarioSchema.safeParse(player({ food: 6.5 })).success, false);
  const capped = scenarioSchema.safeParse(player({ food: 6, saturation: 7 }));
  assert.deepEqual(capped.error?.issues.map((issue) => issue.path), [["players", 0, "saturation"]]);
  const peaceful = scenarioSchema.safeParse({ ...player({ food: 6 }), world: { difficulty: "peaceful" } });
  assert.deepEqual(peaceful.error?.issues.map((issue) => issue.path), [["players", 0, "food"]]);
  assert.equal(scenarioSchema.safeParse({ ...player({ food: 20, saturation: 3 }), world: { difficulty: "peaceful" } }).success, true);
});

test("inventory and equipment items may carry vanilla item components", () => {
  const base = { client: { command: "test-client" }, goal: { kind: "completion" as const } };
  const items = (inventory: string, offhand = "shield") => scenarioSchema.safeParse({
    ...base, players: [{ name: "Worn", inventory: [{ item: inventory }], equipment: { offhand } }],
  });
  assert.equal(items("diamond_pickaxe[damage=1556]", "shield[damage=335]").success, true);
  assert.equal(items("minecraft:shield[minecraft:damage=335]").success, true);
  assert.equal(items("potion[potion_contents={potion:\"minecraft:healing\"}]").success, true);
  assert.equal(items("bread").success, true);
  const rejected = items("Diamond Pickaxe", "shield[damage=335");
  assert.deepEqual(rejected.error?.issues.map((issue) => issue.path.join(".")), ["players.0.inventory.0.item", "players.0.equipment.offhand"]);
  assert.match(rejected.error?.issues[0]?.message ?? "", /optionally with \[components\]/u);
  assert.equal(items("shield[damage=1]trailing").success, false);
});
