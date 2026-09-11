import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRunCatalog, loadScenarioCatalog } from "./catalog.js";

test("catalog resolves client paths and expands verification locations", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-catalog-"));
  const common = { name: "same-name", players: [{ name: "Tester" }], client: { command: "bun", args: ["driver.ts"] }, goal: { kind: "completion" } };
  try {
    await mkdir(join(root, "flat"));
    await mkdir(join(root, "natural"));
    await mkdir(join(root, "scenarios"));
    await writeFile(join(root, "flat", "one.yaml"), JSON.stringify({ ...common, world: { type: "flat" } }));
    await writeFile(join(root, "evidence.json"), JSON.stringify({ results: [] }));
    await writeFile(join(root, "natural", "one.yaml"), JSON.stringify({ ...common, world: { type: "default", seed: 42 } }));
    await writeFile(join(root, "natural", "verify.yaml"), JSON.stringify({ ...common,
      world: { type: "default", seed: 99 }, verification: { radius: 50, locations: [[0, 70, 0], [500, 80, 500]] },
    }));
    await writeFile(join(root, "scenarios", "basic.yaml"), JSON.stringify(common));
    const sources = await loadScenarioCatalog([root]);
    assert.equal(sources.scenarios.length, 4, "verification sources are not expanded twice");
    assert.equal(sources.scenarios[2]!.scenario.verification?.locations.length, 2);
    const catalog = await loadRunCatalog([root], "LabSpectator");
    assert.equal(catalog.initial, undefined);
    assert.deepEqual(catalog.scenarios.map(({ id }) => id), ["flat/one", "natural/one", "natural/verify@1", "natural/verify@2", "scenarios/basic"]);
    assert.deepEqual(catalog.scenarios.map(entry => entry.category), ["flat", "natural", "natural", "natural", "other"]);
    assert.equal(catalog.scenarios[0]!.scenario.name, "same-name", "catalog identity must not rewrite the client contract");
    assert.equal(catalog.scenarios[0]!.scenario.client.cwd, join(root, "flat"));
    assert.deepEqual(catalog.scenarios[3]!.scenario.players[0]!.pos, [500, 80, 500]);
    const direct = await loadRunCatalog([join(root, "flat", "one.yaml")], "LabSpectator");
    assert.equal(direct.initial, "one");
    await writeFile(join(root, "natural", "verify@1.yaml"), JSON.stringify(common));
    await assert.rejects(loadRunCatalog([root]), /duplicate scenario id 'natural\/verify@1' after location expansion/);
    await rm(join(root, "natural", "verify@1.yaml"));
    await writeFile(join(root, "reserved.yaml"), JSON.stringify({ ...common, players: [{ name: "labspectator" }] }));
    await assert.rejects(loadRunCatalog([root], "LabSpectator"), /reserved for the Mine Labs spectator/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("discovery deduplicates overlaps, accepts explicit JSON, and rejects invalid inputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = JSON.stringify({ client: { command: "bun" }, goal: { kind: "completion" } });
  const folder = join(root, "scenarios");
  await mkdir(folder);
  const yaml = join(folder, "example.YAML");
  const json = join(root, "explicit.json");
  await writeFile(yaml, source);
  await writeFile(json, source);
  const catalog = await loadRunCatalog([folder, yaml, json]);
  assert.deepEqual(catalog.scenarios.map(entry => entry.id), ["1/example", "3/explicit"]);
  assert.equal((await loadRunCatalog([json])).initial, "explicit");
  await assert.rejects(loadScenarioCatalog([]), /no scenario paths/);
  await assert.rejects(loadScenarioCatalog([join(root, "missing")]), /cannot read scenario path/);
  await writeFile(join(root, "notes.txt"), source);
  await assert.rejects(loadScenarioCatalog([join(root, "notes.txt")]), /YAML\/JSON file/);
  await mkdir(join(root, "empty"));
  await assert.rejects(loadScenarioCatalog([join(root, "empty")]), /no scenario files/);
  await writeFile(join(folder, "example.yml"), source);
  await assert.rejects(loadRunCatalog([folder]), /duplicate scenario id/);
  await rm(join(folder, "example.yml"));
  await writeFile(yaml, "broken: [");
  await assert.rejects(loadScenarioCatalog([folder]), /not valid YAML\/JSON/);
});
