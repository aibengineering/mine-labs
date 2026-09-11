import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadScenario } from "./loader.js";
import { scenarioSchema } from "./schema.js";

test("client commands run relative to the scenario file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-client-scenario-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "scenario.yaml");
  await writeFile(
    file,
    [
      "name: java-client",
      "client:",
      "  command: java",
      "  args: [-jar, ./bot.jar]",
      "goal:",
      "  kind: completion",
    ].join("\n"),
  );

  const scenario = await loadScenario(file);
  assert.equal(scenario.client.cwd, dirname(file));
});

test("a scenario template supplies reusable world setup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-template-scenario-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const templates = join(root, "templates");
  const scenarios = join(root, "scenarios");
  await Promise.all([mkdir(templates), mkdir(scenarios)]);
  await writeFile(
    join(templates, "arena.yaml"),
    [
      "world:",
      "  type: flat",
      "  gamerules:",
      "    doMobSpawning: false",
      "reset:",
      "  - fill -4 -59 -4 4 -50 4 air",
      "geometry:",
      "  - setblock: { block: stone, at: [0, -59, 0] }",
    ].join("\n"),
  );
  const file = join(scenarios, "zombie.yaml");
  await writeFile(
    file,
    [
      "template: ../templates/arena.yaml",
      "client: { command: test-client }",
      "goal: { kind: completion }",
    ].join("\n"),
  );

  const scenario = await loadScenario(file);

  assert.equal(scenario.world.gamerules.doMobSpawning, false);
  assert.deepEqual(scenario.reset, ["fill -4 -59 -4 4 -50 4 air"]);
  assert.deepEqual(scenario.geometry, [{ setblock: { block: "stone", at: [0, -59, 0] } }]);
  assert.equal(scenario.client.cwd, scenarios);
});

test("scenario fields override template fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-template-override-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "template.yaml"),
    "world: { type: flat, gamerules: { doMobSpawning: false } }\n",
  );
  const file = join(root, "scenario.yaml");
  await writeFile(
    file,
    [
      "template: ./template.yaml",
      "world: { type: default, seed: 1 }",
      "client: { command: test-client }",
      "goal: { kind: completion }",
    ].join("\n"),
  );

  const scenario = await loadScenario(file);
  assert.deepEqual(scenario.world, { type: "default", dimension: "overworld", seed: 1, structures: false, time: "day", gamerules: {} });
});

test("templates can supply scenario fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-template-fields-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "template.yaml"),
    [
      "entities:",
      "  - type: zombie",
      "    pos: [0, 0, 0]",
    ].join("\n"),
  );
  const file = join(root, "scenario.yaml");
  await writeFile(
    file,
    [
      "template: ./template.yaml",
      "client: { command: test-client }",
      "goal: { kind: completion }",
    ].join("\n"),
  );

  const scenario = await loadScenario(file);
  assert.deepEqual(scenario.entities, [{ type: "zombie", pos: [0, 0, 0] }]);
});

test("a scenario requires an explicit client command", () => {
  const parsed = scenarioSchema.safeParse({
    goal: { kind: "completion" },
  });

  assert.equal(parsed.success, false);
});
