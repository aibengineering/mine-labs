import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { scenarioSchema, type ScenarioInput } from "../scenario/schema.js";
import { runSession } from "../session/run.js";
import type { RunResult } from "./run.js";

/**
 * Scenario features that only the real game can confirm: run one fixture twice
 * on one server, so the second trial also proves the reused world was reset.
 * Needs Java 21 and a server download or cache, like the shutdown test.
 */
const client = { command: "bun", args: [resolve("src/trial/test-fixtures/observing-client.mjs")] };

async function runTwice(input: ScenarioInput): Promise<RunResult[]> {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-fixture-features-"));
  const results: RunResult[] = [];
  const logs: string[] = [];
  try {
    await runSession({
      scenarios: [{ scenario: scenarioSchema.parse(input) }], rootDir: root, cycles: 2, jobs: 1, delayMs: 0,
      log: (message) => logs.push(message), onResult: (result) => { results.push(result); },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.ok(logs.some((message) => message.includes(`Resetting world for ${input.name}`)), "the second trial reused the world");
  return results;
}

const arena = {
  world: { type: "flat" as const, gamerules: { doDaylightCycle: false } },
  reset: ["fill -8 -60 -8 8 -50 8 air"],
  setup: ["scoreboard objectives add ml_fixture dummy", "scoreboard players set #hits ml_fixture 0"],
};

test("a schedule runs each entry once per trial, from start, on a reused server too", { timeout: 180_000 }, async () => {
  const results = await runTwice({
    name: "schedule-live", ...arena, client,
    players: [{ name: "Scheduled", pos: [0.5, -60, 0.5] }],
    schedule: [
      { afterTicks: 0, run: "scoreboard players add #hits ml_fixture 1" },
      { afterTicks: 10, run: "summon minecraft:pig 3 -60 0 {NoAI:1b}" },
      { when: "score #hits ml_fixture matches 1..", run: ["summon minecraft:cow 5 -60 0 {NoAI:1b}", "/summon minecraft:cow 5 -60 2 {NoAI:1b}"] },
    ],
    params: { holdMs: 3000 },
    goal: { kind: "all", timeout: 30, goals: [
      { kind: "survive", seconds: 2 },
      { kind: "entityCount", entity: "pig", min: 1, max: 1 },
      { kind: "entityCount", entity: "cow", min: 2, max: 2 },
      { kind: "completion" },
    ] },
  });
  assert.deepEqual(results.map((result) => [result.outcome, result.goal.detail]), [["pass", "all(4) passed"], ["pass", "all(4) passed"]]);
});

test("a declared starting hunger is what the client observes before it is prepared", { timeout: 180_000 }, async () => {
  const results = await runTwice({
    name: "hunger-live", ...arena, client,
    world: { type: "flat", gamerules: { naturalRegeneration: false } },
    players: [
      { name: "Starving", pos: [0.5, -60, 0.5], food: 6 },
      { name: "Peckish", pos: [2.5, -60, 0.5], food: 15, saturation: 3, health: 11 },
      { name: "Sated", pos: [4.5, -60, 0.5], saturation: 13 },
    ],
    params: { expectByPlayer: {
      Starving: { food: 6, saturation: 0, health: 20 },
      Peckish: { food: 15, saturation: 3, health: 11 },
      Sated: { food: 20, saturation: 13, health: 20 },
    } },
    goal: { kind: "all", timeout: 60, goals: [
      { kind: "completion", who: "Starving" }, { kind: "completion", who: "Peckish" }, { kind: "completion", who: "Sated" },
    ] },
  });
  assert.deepEqual(results.map((result) => [result.outcome, result.goal.detail, result.error]), [["pass", "all(3) passed", undefined], ["pass", "all(3) passed", undefined]], JSON.stringify(results.map((result) => result.goal)));
});

test("kill and entityCount count only the tagged or nearby entities they name", { timeout: 180_000 }, async () => {
  const results = await runTwice({
    name: "scoped-live", ...arena, client,
    world: { type: "flat", time: "midnight", gamerules: { doDaylightCycle: false } },
    players: [{ name: "Counter", pos: [0.5, -60, 0.5] }],
    entities: [
      { type: "zombie", pos: [3, -60, 3], nbt: "{NoAI:1b,Tags:[\"penA\"]}" },
      { type: "zombie", pos: [4, -60, 3], nbt: "{NoAI:1b,Tags:[\"penA\"]}" },
      { type: "zombie", pos: [-5, -60, -5], nbt: "{NoAI:1b}" },
    ],
    schedule: [{ afterTicks: 20, run: "kill @e[type=minecraft:zombie,tag=penA]" }],
    params: { holdMs: 3000 },
    goal: { kind: "all", timeout: 30, goals: [
      { kind: "kill", target: "zombie", tag: "penA" },
      { kind: "entityCount", entity: "zombie", near: { pos: [-5, -60, -5], radius: 2 }, min: 1, max: 1 },
      { kind: "entityCount", entity: "zombie", near: { pos: [3.5, -60, 3], radius: 3 }, max: 0 },
      { kind: "entityCount", entity: "zombie", min: 1, max: 1 },
      { kind: "completion" },
    ] },
  });
  assert.deepEqual(results.map((result) => [result.outcome, result.goal.detail, result.error]), [["pass", "all(5) passed", undefined], ["pass", "all(5) passed", undefined]], JSON.stringify(results.map((result) => result.goal)));
});
