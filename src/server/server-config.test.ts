import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scenarioSchema } from "../scenario/schema.js";
import { MinecraftServer } from "./server.js";

test("structure generation is an explicit boolean opt-in", () => {
  const minimal = { client: { command: "bun" }, goal: { kind: "completion" } };
  assert.equal(scenarioSchema.parse(minimal).world.structures, false);
  assert.equal(scenarioSchema.parse({ ...minimal, world: { structures: true } }).world.structures, true);
  assert.equal(scenarioSchema.safeParse({ ...minimal, world: { structures: "true" } }).success, false);
});

test("server config preserves world settings and binds offline play to loopback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-structures-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const structures of [false, true]) {
    const server = new MinecraftServer({
      version: "1.21.4", worldDir: join(root, "world"), gamePort: 0, rconPort: 0,
      rconPassword: "test", worldType: "default", seed: 20260906, structures, operators: [],
    }, "unused.jar", () => {}, { gamePort: 0, rconPort: 0, release() {} });
    await server["writeConfig"]();
    const properties = await readFile(join(root, "server.properties"), "utf8");
    assert.ok(properties.split("\n").includes(`generate-structures=${structures}`));
    assert.ok(properties.split("\n").includes("level-seed=20260906"));
    assert.ok(properties.split("\n").includes("server-ip=127.0.0.1"));
    assert.ok(properties.split("\n").includes("online-mode=false"));
  }
});
