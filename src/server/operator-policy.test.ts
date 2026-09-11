import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { defaultOperatorProfiles, offlinePlayerUuid } from "./operator-policy.js";

test("Mine Labs operators become offline-server profiles and deduplicate identities", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mine-labs-operators-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "config.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, operators: ["TestOperator", "TestViewer", "TESTOPERATOR"] }));
  assert.deepEqual(defaultOperatorProfiles({ configFile: file }), [
    { uuid: offlinePlayerUuid("TESTOPERATOR"), name: "TESTOPERATOR", level: 2, bypassesPlayerLimit: true },
    { uuid: offlinePlayerUuid("TestViewer"), name: "TestViewer", level: 2, bypassesPlayerLimit: true },
  ]);
});

test("operator configuration resolves XDG, home fallback, and explicit overrides independently", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mine-labs-config-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const xdg = join(home, "xdg");
  const override = join(home, "override.json");
  const explicit = join(home, "explicit.json");
  for (const [file, name] of [
    [join(home, ".config", "minelabs", "config.json"), "HomeOperator"],
    [join(xdg, "minelabs", "config.json"), "XdgOperator"],
    [override, "EnvOperator"], [explicit, "FileOperator"],
  ] as const) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, operators: [name] }));
  }
  assert.equal(defaultOperatorProfiles({ home, env: {} })[0]?.name, "HomeOperator");
  assert.equal(defaultOperatorProfiles({ home, env: { XDG_CONFIG_HOME: xdg } })[0]?.name, "XdgOperator");
  const env = { XDG_CONFIG_HOME: xdg, MINE_LABS_CONFIG: override };
  assert.equal(defaultOperatorProfiles({ home, env })[0]?.name, "EnvOperator");
  assert.equal(defaultOperatorProfiles({ home, env, configFile: explicit })[0]?.name, "FileOperator");
  assert.deepEqual(defaultOperatorProfiles({ home, env: { XDG_CONFIG_HOME: join(home, "missing") } }), []);
});

test("operator configuration rejects malformed files and invalid names", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mine-labs-invalid-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "config.json");
  for (const value of [null, {}, { schemaVersion: 2 }, { schemaVersion: 1, operators: "TestOperator" },
    { schemaVersion: 1, operators: [123] }, { schemaVersion: 1, operators: ["Invalid Name"] }]) {
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => defaultOperatorProfiles({ configFile: file }), /Mine Labs operator config/);
  }
  writeFileSync(file, "{");
  assert.throws(() => defaultOperatorProfiles({ configFile: file }), /Could not read Mine Labs operator config/);
  writeFileSync(file, JSON.stringify({ schemaVersion: 1 }));
  assert.deepEqual(defaultOperatorProfiles({ configFile: file }), []);
});
