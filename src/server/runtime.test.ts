import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linkServerRuntime } from "./runtime.js";

test("run roots share a versioned runtime without owning its files", async (t) => {
  const originalHome = process.env.MINE_LABS_HOME;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mine-labs-runtime-"));
  t.after(async () => {
    if (originalHome === undefined) delete process.env.MINE_LABS_HOME;
    else process.env.MINE_LABS_HOME = originalHome;
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  process.env.MINE_LABS_HOME = join(temporaryRoot, "home");
  const first = join(temporaryRoot, "first");
  const second = join(temporaryRoot, "second");

  await linkServerRuntime(first, "1.21.4");
  await linkServerRuntime(second, "1.21.4");
  await writeFile(join(first, "libraries", "shared.jar"), "shared", "utf8");

  assert.equal(await realpath(join(first, "libraries")), await realpath(join(second, "libraries")));
  await rm(join(first, "libraries"), { recursive: true, force: true });
  assert.equal(await readFile(join(second, "libraries", "shared.jar"), "utf8"), "shared");
});

test("persistent run roots follow the current user's runtime cache", async (t) => {
  const originalHome = process.env.MINE_LABS_HOME;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mine-labs-runtime-switch-"));
  t.after(async () => {
    if (originalHome === undefined) delete process.env.MINE_LABS_HOME;
    else process.env.MINE_LABS_HOME = originalHome;
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const runRoot = join(temporaryRoot, "run");
  const firstHome = join(temporaryRoot, "first-home");
  const secondHome = join(temporaryRoot, "second-home");

  process.env.MINE_LABS_HOME = firstHome;
  await linkServerRuntime(runRoot, "1.21.4");
  await writeFile(join(runRoot, "libraries", "first.jar"), "first", "utf8");

  process.env.MINE_LABS_HOME = secondHome;
  await linkServerRuntime(runRoot, "1.21.4");

  assert.equal(await realpath(join(runRoot, "libraries")), join(secondHome, "runtimes", "1.21.4", "libraries"));
  assert.equal(await readFile(join(firstHome, "runtimes", "1.21.4", "libraries", "first.jar"), "utf8"), "first");
});

test("never replaces a real runtime directory", async (t) => {
  const originalHome = process.env.MINE_LABS_HOME;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mine-labs-runtime-directory-"));
  t.after(async () => {
    if (originalHome === undefined) delete process.env.MINE_LABS_HOME;
    else process.env.MINE_LABS_HOME = originalHome;
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  process.env.MINE_LABS_HOME = join(temporaryRoot, "home");
  const runRoot = join(temporaryRoot, "run");
  await mkdir(join(runRoot, "libraries"), { recursive: true });
  await writeFile(join(runRoot, "libraries", "owned.jar"), "owned", "utf8");

  await assert.rejects(() => linkServerRuntime(runRoot, "1.21.4"), /Refusing to replace the real directory/);
  assert.equal(await readFile(join(runRoot, "libraries", "owned.jar"), "utf8"), "owned");
});
