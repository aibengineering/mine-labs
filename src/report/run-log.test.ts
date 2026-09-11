import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRunLog } from "./run-log.js";

test("client diagnostics are drained in order even when the trial throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mine-labs-log-"));
  try {
    const emitted: string[] = [];
    await assert.rejects(withRunLog(dir, (line) => emitted.push(line), async (log) => {
      log("SCREEN placement rejected");
      log("SCREEN final evidence");
      throw new Error("trial failed");
    }), /trial failed/);
    const saved = await readFile(join(dir, "client.log"), "utf8");
    assert.deepEqual(saved.trim().split("\n").map((line) => line.slice(line.indexOf(" ") + 1)), emitted);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
