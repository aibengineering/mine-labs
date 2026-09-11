import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionController } from "../session/controller.js";
import { startUiServer, type UiSnapshot } from "./server.js";

test("large retained and live results remain readable in the polling UI without shortening evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-status-preview-"));
  const detail = "Recorded diagnostic evidence: " + "x".repeat(1_100_000);
  const result = { scenario: "large-result", outcome: "fail" as const, elapsedMs: 1000,
    goalText: "complete", goal: { state: "failed" as const, detail } };
  const runDir = join(root, "runs", "2026-09-10T00-00-00-000Z-large-result");
  await mkdir(runDir, { recursive: true });
  const reportPath = join(runDir, "results.json");
  const report = JSON.stringify(result);
  await writeFile(reportPath, report);
  const server = await startUiServer({ controller: new SessionController(), rootDir: root, port: 0 });
  try {
    const read = async () => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/status`);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(text.length < 1_000_000, "the Minecraft client rejects larger status responses");
      return JSON.parse(text) as UiSnapshot;
    };
    const retained = (await read()).recent[0]!;
    assert.equal(retained.scenario, result.scenario);
    assert.equal(retained.outcome, "fail");
    assert.ok(retained.detail.startsWith("Recorded diagnostic evidence:"));
    assert.ok(retained.detail.length <= 1000);
    assert.match(retained.detail, /full detail in results\.json/);
    server.onTrialResult(result, { trialId: "live", sequence: 1, workerIndex: 0, cycle: 1,
      scenarioIndex: 0, scenarioCount: 1, scenario: result.scenario, goalText: "complete", runDir,
      startedAt: new Date().toISOString() });
    const live = await read();
    assert.equal(live.recent.length, 2);
    assert.equal(live.recent[0]!.detail, retained.detail);
    assert.equal(result.goal.detail, detail, "the caller's complete evidence remains untouched");
    assert.equal(await readFile(reportPath, "utf8"), report, "retained evidence is never rewritten");
    server.onTrialResult({ ...result, goal: {state: "failed", detail: "short reason"} }, {
      trialId: "short", sequence: 2, workerIndex: 0, cycle: 1, scenarioIndex: 0,
      scenarioCount: 1, scenario: result.scenario, goalText: "complete", runDir, startedAt: new Date().toISOString(),
    });
    assert.equal((await read()).recent[0]!.detail, "short reason");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
