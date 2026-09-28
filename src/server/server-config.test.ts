import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scenarioSchema } from "../scenario/schema.js";
import { MinecraftServer, type ServerConfig } from "./server.js";

/** A server that is never started for real: only its config and launch are exercised. */
function serverAt(root: string, config: Partial<ServerConfig>, log: (line: string) => void = () => {}): MinecraftServer {
  return new MinecraftServer({
    version: "1.21.4", host: "127.0.0.1", worldDir: join(root, "world"), gamePort: 0, rconPort: 0,
    rconPassword: "test", worldType: "flat", structures: false, operators: [], ...config,
  }, "unused.jar", log, { gamePort: 0, rconPort: 0, release() {} });
}

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
    const server = serverAt(root, { worldType: "default", seed: 20260906, structures });
    await server["writeConfig"]();
    const properties = await readFile(join(root, "server.properties"), "utf8");
    assert.ok(properties.split("\n").includes(`generate-structures=${structures}`));
    assert.ok(properties.split("\n").includes("level-seed=20260906"));
    assert.ok(properties.split("\n").includes("server-ip=127.0.0.1"));
    assert.ok(properties.split("\n").includes("online-mode=false"));
  }
});

test("server config binds a Tailscale remote mode server to the tailnet address only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = serverAt(root, { host: "100.64.0.7" });
  await server["writeConfig"]();
  const properties = (await readFile(join(root, "server.properties"), "utf8")).split("\n");
  assert.ok(properties.includes("server-ip=100.64.0.7"));
  assert.equal(server.host, "100.64.0.7");
});

test("a server refused by an old Java fails with what to install, not the JVM's class version", {
  skip: process.platform === "win32" && "the stand-in JDK is a shell script",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-old-java-"));
  const originalJavaHome = process.env.JAVA_HOME;
  t.after(async () => {
    if (originalJavaHome === undefined) delete process.env.JAVA_HOME;
    else process.env.JAVA_HOME = originalJavaHome;
    await rm(root, { recursive: true, force: true });
  });
  // A stand-in Java 17 that refuses the jar the way the real one refuses 1.21.4.
  const java = join(root, "jdk-17", "bin", "java");
  await mkdir(join(root, "jdk-17", "bin"), { recursive: true });
  await writeFile(java, "#!/bin/sh\n"
    + "echo 'Error: LinkageError occurred while loading main class net.minecraft.bundler.Main' >&2\n"
    + "echo '\tjava.lang.UnsupportedClassVersionError: net/minecraft/bundler/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0' >&2\n"
    + "exit 1\n");
  await chmod(java, 0o755);
  process.env.JAVA_HOME = join(root, "jdk-17");
  // Nothing listens on port 1, so the readiness probe fails at once and sees the exit.
  const server = serverAt(join(root, "run"), { rconPort: 1 });
  await assert.rejects(server.start(), new RegExp(`^Error: Minecraft 1\\.21\\.4 needs Java 21 or newer, but ${java} is Java 17\\.`, "u"));
  await server.stop({ force: true });
});
