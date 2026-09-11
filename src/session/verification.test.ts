import assert from "node:assert/strict";
import test from "node:test";
import { scenarioSchema } from "../scenario/schema.js";
import { expandVerificationLocations, nameVerificationPlayer, planVerificationBatches } from "./verification.js";
import { runSession } from "./run.js";

function fixture() {
  return scenarioSchema.parse({
    name: "obsidian", world: { type: "default", seed: 123 },
    verification: { radius: 256, locations: [[0, 70, 0], [800, 70, 0], [1600, 70, 0]] },
    players: [{ name: "Collector" }], client: { command: "bun" },
    goal: { kind: "all", goals: [{ kind: "completion", who: "Collector" }, { kind: "hasItem", item: "obsidian" }] },
  });
}

test("one seed and several locations expand to separate attempts sharing a batch", () => {
  const source = fixture();
  const attempts = expandVerificationLocations([source]);
  assert.equal(attempts.length, 3);
  assert.equal(planVerificationBatches(attempts, 4).length, 1);
  assert.equal(planVerificationBatches(attempts, 2).length, 2);
  const renamed = nameVerificationPlayer(attempts[1]!, 9);
  assert.equal(renamed.players[0]!.name, "Verify9");
  assert.deepEqual(renamed.players[0]!.pos, [800, 70, 0]);
  assert.equal(renamed.goal.kind, "all");
  if (renamed.goal.kind === "all") assert.ok(renamed.goal.goals.every((goal) => "who" in goal && goal.who === "Verify9"));
  assert.equal(source.players[0]!.name, "Collector");
});

test("overlapping attempts, different seeds and world rules never share a world", () => {
  const [a, b] = expandVerificationLocations([fixture()]);
  assert.equal(planVerificationBatches([a!, a!], 4).length, 2);
  assert.equal(planVerificationBatches([a!, { ...b!, world: { ...b!.world, structures: true } }], 4).length, 2);
  assert.equal(planVerificationBatches([a!, { ...b!, world: { ...b!.world, seed: 456 } }], 4).length, 2);
  assert.equal(planVerificationBatches([a!, { ...b!, world: { ...b!.world, gamerules: { doMobSpawning: true } } }], 4).length, 2);
});

test("global commands and global goals are rejected before launching clients", () => {
  assert.throws(() => expandVerificationLocations([{ ...fixture(), tick: ["kill @e"] }]), /cannot use tick/);
  assert.throws(() => expandVerificationLocations([{ ...fixture(), goal: { kind: "kill", target: "zombie" } }]), /not player-scoped/);
  assert.throws(() => expandVerificationLocations([{ ...fixture(), verification: undefined }]), /requires verification/);
});

test("sessions reject unexpanded verification locations", async () => {
  await assert.rejects(runSession({
    scenarios: [{ scenario: fixture() }],  rootDir: "unused", log: () => {},
  }), /Expand verification locations/);
});
