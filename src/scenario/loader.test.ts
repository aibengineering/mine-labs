import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadScenario, MAX_TEMPLATE_DEPTH, ScenarioError } from "./loader.js";
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
  assert.deepEqual(scenario.tags, [], "old fixtures need no labels");
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
      "tags: [acceptance]",
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
  assert.deepEqual(scenario.tags, ["acceptance"]);
  assert.deepEqual(scenario.reset, ["fill -4 -59 -4 4 -50 4 air"]);
  assert.deepEqual(scenario.geometry, [{ setblock: { block: "stone", at: [0, -59, 0] } }]);
  assert.equal(scenario.client.cwd, scenarios);
});

test("scenario fields override template fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-template-override-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "template.yaml"),
    "tags: [acceptance]\nworld: { type: flat, gamerules: { doMobSpawning: false } }\n",
  );
  const file = join(root, "scenario.yaml");
  await writeFile(
    file,
    [
      "template: ./template.yaml",
      "world: { type: default, seed: 1 }",
      "tags: [regression]",
      "client: { command: test-client }",
      "goal: { kind: completion }",
    ].join("\n"),
  );

  const scenario = await loadScenario(file);
  assert.deepEqual(scenario.world, { type: "default", dimension: "overworld", seed: 1, structures: false, time: "day", gamerules: {} });
  assert.deepEqual(scenario.tags, ["regression"], "fixture replaces inherited labels");
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

test("a template can build on another template, each level overriding whole fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-template-chain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "templates", "base"), { recursive: true });
  await mkdir(join(root, "scenarios"));
  await mkdir(join(root, "templates", "base", "mods"));
  await writeFile(
    join(root, "templates", "base", "arena.yaml"),
    [
      "tags: [base]",
      "world: { type: default, seed: 7, gamerules: { doMobSpawning: false } }",
      "reset: [fill -4 -59 -4 4 -50 4 air]",
      "spectator: { mods: [{ id: viewer, path: ./mods/viewer.jar }] }",
    ].join("\n"),
  );
  await writeFile(
    join(root, "templates", "no-regen.yaml"),
    [
      "template: ./base/arena.yaml",
      "world: { type: default, seed: 7, gamerules: { doMobSpawning: false, naturalRegeneration: false } }",
    ].join("\n"),
  );
  const file = join(root, "scenarios", "wounded.yaml");
  await writeFile(
    file,
    [
      "template: ../templates/no-regen.yaml",
      "tags: [scenario]",
      "client: { command: test-client }",
      "goal: { kind: completion }",
    ].join("\n"),
  );

  const scenario = await loadScenario(file);
  assert.deepEqual(scenario.world.gamerules, { doMobSpawning: false, naturalRegeneration: false });
  assert.equal(scenario.world.seed, 7);
  assert.deepEqual(scenario.reset, ["fill -4 -59 -4 4 -50 4 air"], "untouched fields come through from the base");
  assert.deepEqual(scenario.tags, ["scenario"]);
  assert.equal(scenario.spectator?.mods[0]?.path, join(root, "templates", "base", "mods", "viewer.jar"),
    "a mod resolves against the template that declares it, however deep");
  assert.equal(scenario.client.cwd, join(root, "scenarios"));
});

test("a template cycle is reported with the loop it forms", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-template-cycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "a.yaml"), "template: ./b.yaml\n");
  await writeFile(join(root, "b.yaml"), "template: ./a.yaml\n");
  const file = join(root, "scenario.yaml");
  await writeFile(file, "template: ./a.yaml\nclient: { command: test-client }\ngoal: { kind: completion }\n");

  await assert.rejects(loadScenario(file), (error: unknown) => {
    assert.ok(error instanceof ScenarioError);
    assert.equal(error.message,
      `scenario '${file}' has a template cycle: ${join(root, "a.yaml")} -> ${join(root, "b.yaml")} -> ${join(root, "a.yaml")}`);
    return true;
  });
});

test("a template that names its own scenario is a cycle, not a recursion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-template-self-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "scenario.yaml");
  await writeFile(join(root, "t.yaml"), "template: ./scenario.yaml\n");
  await writeFile(file, "template: ./t.yaml\nclient: { command: test-client }\ngoal: { kind: completion }\n");
  await assert.rejects(loadScenario(file), /has a template cycle: .*scenario\.yaml -> .*t\.yaml -> .*scenario\.yaml$/u);
});

test("templates nest at most MAX_TEMPLATE_DEPTH deep", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-template-depth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scenarioText = "template: ./t1.yaml\nclient: { command: test-client }\ngoal: { kind: completion }\n";
  const file = join(root, "scenario.yaml");
  await writeFile(file, scenarioText);
  // t1 -> ... -> tN, where only the last names no template.
  const writeChain = async (length: number): Promise<void> => {
    for (let level = 1; level <= length; level++) {
      await writeFile(join(root, `t${level}.yaml`), level < length ? `template: ./t${level + 1}.yaml\n` : `tags: [t${level}]\n`);
    }
  };

  await writeChain(MAX_TEMPLATE_DEPTH);
  assert.deepEqual((await loadScenario(file)).tags, [`t${MAX_TEMPLATE_DEPTH}`]);

  await writeChain(MAX_TEMPLATE_DEPTH + 1);
  await assert.rejects(loadScenario(file), new RegExp(`nests templates more than ${MAX_TEMPLATE_DEPTH} deep`, "u"));
});

test("a nested template's own errors name the template that referenced it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-template-nested-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "scenario.yaml");
  await writeFile(join(root, "outer.yaml"), "template: ./inner.yaml\n");
  await writeFile(join(root, "inner.yaml"), "wrold: { type: flat }\n");
  await writeFile(file, "template: ./outer.yaml\nclient: { command: test-client }\ngoal: { kind: completion }\n");
  await assert.rejects(loadScenario(file), (error: unknown) => {
    assert.ok(error instanceof ScenarioError);
    assert.ok(error.message.startsWith(
      `template '${join(root, "inner.yaml")}' referenced by template '${join(root, "outer.yaml")}' (from scenario '${file}') failed validation:`,
    ), error.message);
    return true;
  });

  await writeFile(join(root, "outer.yaml"), "template: ./missing.yaml\n");
  await assert.rejects(loadScenario(file), /cannot read template file '.*missing\.yaml' referenced by template '.*outer\.yaml'/u);
});

test("a scenario without a name is named after its file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-scenario-name-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const minimal = "client: { command: test-client }\ngoal: { kind: completion }\n";
  await writeFile(join(root, "zombie-hunt.yaml"), minimal);
  await writeFile(join(root, "named.yaml"), `name: explicit\n${minimal}`);
  await writeFile(join(root, "template.yaml"), "name: from-template\n");
  await writeFile(join(root, "templated.yml"), `template: ./template.yaml\n${minimal}`);
  await writeFile(join(root, "json-scenario.json"), JSON.stringify({ client: { command: "test-client" }, goal: { kind: "completion" } }));

  assert.equal((await loadScenario(join(root, "zombie-hunt.yaml"))).name, "zombie-hunt");
  assert.equal((await loadScenario(join(root, "named.yaml"))).name, "explicit");
  assert.equal((await loadScenario(join(root, "templated.yml"))).name, "from-template", "a template's name still wins over the stem");
  assert.equal((await loadScenario(join(root, "json-scenario.json"))).name, "json-scenario");
});

test("a scenario requires an explicit client command", () => {
  const parsed = scenarioSchema.safeParse({
    goal: { kind: "completion" },
  });

  assert.equal(parsed.success, false);
});
