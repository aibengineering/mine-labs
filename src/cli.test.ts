import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", ["./bin/mine-labs.mjs", ...args], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function list(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return cli(["list", ...args]);
}

test("list and run take repeatable, comma-separated tag filters and report what they dropped", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-cli-tags-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scenario = (tags: string[]) => JSON.stringify({ tags, client: { command: "bun" }, goal: { kind: "completion" } });
  await mkdir(join(root, "suite"));
  await writeFile(join(root, "suite", "fast.yaml"), scenario(["smoke"]));
  await writeFile(join(root, "suite", "slow.yaml"), scenario(["smoke", "slow"]));
  await writeFile(join(root, "suite", "nav.yaml"), scenario(["navigation"]));
  await writeFile(join(root, "suite", "plain.yaml"), scenario([]));
  const folder = join(root, "suite");

  const both = list([folder, "--tag", "smoke", "--tag", "navigation", "--skip-tag", "slow"]);
  assert.equal(both.status, 0, both.stderr);
  assert.match(both.stdout, /--tag smoke,navigation --skip-tag slow: 2 scenarios selected, 2 filtered out/u);
  assert.deepEqual(both.stdout.trim().split("\n").slice(1).map((line) => line.trim()), ["fast", "nav"]);

  const commas = list([folder, "--tag", "smoke,navigation"]);
  assert.match(commas.stdout, /3 scenarios selected, 1 filtered out/u);

  const skipped = list([folder, "--skip-tag", "slow,navigation"]);
  assert.deepEqual(skipped.stdout.trim().split("\n").slice(1).map((line) => line.trim()), ["fast", "plain"]);

  const none = list([folder, "--tag", "missing"]);
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /no scenarios match --tag missing: all 4 were filtered out/u);

  // A headless run refuses an empty selection before any server starts.
  const run = cli(["run", folder, "--skip-tag", "smoke,navigation,", "--skip-tag", "", "--out", join(root, "out")]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /expected at least one tag/u);
  const empty = cli(["run", folder, "--tag", "smoke", "--skip-tag", "smoke", "--out", join(root, "out")]);
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /no scenarios match --tag smoke --skip-tag smoke: all 4 were filtered out/u);
});

