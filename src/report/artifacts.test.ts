import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compactIsolatedRun, retainNewestRuns, writeRunResult } from "./artifacts.js";
import type { RunResult } from "../trial/run.js";

test("run retention never removes a parallel worker's active directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-retention-"));
  const runs = join(root, "runs");
  const completed = join(runs, "2026-completed");
  const active = join(runs, "2026-active");
  try {
    await mkdir(completed, { recursive: true });
    await mkdir(active, { recursive: true });

    await retainNewestRuns(runs, 0, new Set([active]));

    assert.deepEqual(await readdir(runs), ["2026-active"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compacting refuses an evidence root, so a run can never prune collected history", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-compact-"));
  const history = join(root, "runs", "2026-earlier-run");
  try {
    await mkdir(history, { recursive: true });

    await assert.rejects(compactIsolatedRun(root), /evidence root/);

    assert.deepEqual(await readdir(join(root, "runs")), ["2026-earlier-run"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compaction retains results and client-owned artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-artifacts-"));
  try {
    await mkdir(join(root, "artifacts", "incident"), { recursive: true });
    await mkdir(join(root, "world"));
    const result: RunResult = { scenario: "example", outcome: "pass", elapsedMs: 1,
      goal: { state: "passed", detail: "done" }, goalText: "complete" };
    await writeRunResult(root, result);
    await compactIsolatedRun(root);
    assert.deepEqual((await readdir(root)).sort(), ["artifacts", "results.json"]);
    assert.deepEqual(JSON.parse(await readFile(join(root, "results.json"), "utf8")), result);
    assert.deepEqual(await readdir(join(root, "artifacts")), ["incident"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
