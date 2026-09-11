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
