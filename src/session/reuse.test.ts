import assert from "node:assert/strict";
import test from "node:test";
import { scenarioSchema } from "../scenario/schema.js";
import { canResetScenario, worldCompatibilityKey } from "./reuse.js";

const fixture = () => scenarioSchema.parse({
  world: { type: "flat" }, players: [{ name: "Tester", pos: [0.5, -60, 0.5] }],
  reset: ["fill -2 -60 -2 2 -57 2 air"], client: { command: "bun" }, goal: { kind: "completion" },
});

test("reuse requires a declared reset and an arena that can be restored", () => {
  assert.equal(canResetScenario(fixture()), true);
  assert.equal(canResetScenario({ ...fixture(), reset: [] }), false);
  assert.equal(canResetScenario({ ...fixture(), players: [{ name: "Tester", op: true, inventory: [] }] }), false);
  assert.equal(canResetScenario({ ...fixture(), reset: ["fill -10000 -60 -10000 10000 -57 10000 air"] }), false);
});

test("world identity includes generation and inherited settings, while time is reapplied", () => {
  const a = fixture();
  const key = worldCompatibilityKey(a);
  for (const world of [{type: "default"}, {seed: 42}, {structures: true}, {difficulty: "hard"}, {gamerules: {keepInventory: true}}]) {
    assert.notEqual(worldCompatibilityKey(scenarioSchema.parse({...a, world: {...a.world, ...world}})), key);
  }
  assert.equal(worldCompatibilityKey({...a, world: {...a.world, time: "night"}}), key);
  assert.equal(worldCompatibilityKey({...a, world: {...a.world, seed: 42}}), worldCompatibilityKey({...a, world: {...a.world, seed: "42"}}));
});
