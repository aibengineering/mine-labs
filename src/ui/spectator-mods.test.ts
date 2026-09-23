import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadScenario } from "../scenario/loader.js";
import { scenarioSchema } from "../scenario/schema.js";
import { collectSpectatorSetup, installSpectatorMods, spectatorSetupKey } from "./spectator-mods.js";

test("mod paths belong to their declaring YAML, including templates and overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spectator-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "templates"));
  await mkdir(join(root, "scenarios"));
  await writeFile(join(root, "templates", "shared.yaml"), "spectator:\n  mods: [{id: overlay, path: overlay.jar}]\n");
  const file = join(root, "scenarios", "case.yaml");
  const base = "template: ../templates/shared.yaml\nclient: {command: bot}\ngoal: {kind: completion}\n";
  await writeFile(file, base);
  assert.equal((await loadScenario(file)).spectator?.mods[0]?.path, join(root, "templates", "overlay.jar"));
  await writeFile(file, base + "spectator:\n  mods: [{id: overlay, path: other.jar}]\n");
  assert.equal((await loadScenario(file)).spectator?.mods[0]?.path, join(root, "scenarios", "other.jar"));
});

test("catalog mods deduplicate by identity and content and reject conflicts before launch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spectator-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first.jar"), copy = join(root, "copy.jar"), other = join(root, "other.jar");
  await writeFile(first, "one"); await writeFile(copy, "one"); await writeFile(other, "two");
  const scenario = (path: string, value = "1") => scenarioSchema.parse({
    client: { command: "bot" }, goal: { kind: "completion" },
    spectator: { mods: [{ id: "overlay", path }], systemProperties: { "overlay.setting": value } },
  });
  const setup = await collectSpectatorSetup([scenario(first), scenario(copy)]);
  assert.equal(setup.mods.length, 1);
  assert.equal(spectatorSetupKey(setup), spectatorSetupKey(await collectSpectatorSetup([scenario(first)])));
  await assert.rejects(collectSpectatorSetup([scenario(first), scenario(other)]), /Conflicting spectator mod/);
  await assert.rejects(collectSpectatorSetup([scenario(first), scenario(first, "2")]), /Conflicting spectator system property/);
  await assert.rejects(collectSpectatorSetup([scenario(join(root, "missing.jar"))]), /Cannot read spectator mod/);
  const reserved = scenario(first);
  reserved.spectator!.systemProperties = { "minelabs.uiUrl": "override" };
  await assert.rejects(collectSpectatorSetup([reserved]), /reserved/);
  await writeFile(copy, "updated");
  assert.notEqual(spectatorSetupKey(setup), spectatorSetupKey(await collectSpectatorSetup([scenario(copy)])));

  const mods = join(root, "mods");
  await mkdir(mods);
  await writeFile(join(mods, "personal.jar"), "keep");
  await writeFile(join(mods, "mine-labs-spectator-stale.jar"), "remove");
  const fresh = await collectSpectatorSetup([scenario(first)]);
  await installSpectatorMods(mods, fresh);
  assert.deepEqual((await readdir(mods)).sort(), ["mine-labs-spectator-overlay.jar", "personal.jar"]);
  assert.equal(await readFile(join(mods, "mine-labs-spectator-overlay.jar"), "utf8"), "one");
  await installSpectatorMods(mods, { mods: [], systemProperties: {} });
  assert.deepEqual(await readdir(mods), ["personal.jar"]);
});
