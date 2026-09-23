import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionController } from "../session/controller.js";
import { startUiServer, type UiSnapshot } from "./server.js";
import { loadRunCatalog } from "../scenario/catalog.js";
import { inspectScenario } from "../scenario/inspection.js";
import { scenarioSchema } from "../scenario/schema.js";
import { TrialScheduler } from "../session/run.js";
import type { GoalResult } from "../trial/goals.js";
import type { ScenarioInspection } from "../scenario/inspection.js";

test("manual start API reports ready and rejects stale or malformed start requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-manual-start-"));
  const controller = new SessionController();
  const server = await startUiServer({ controller, rootDir: root, port: 0 });
  const post = (body: object) => fetch(`http://127.0.0.1:${server.port}/api/control`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    assert.equal(server.snapshot().autoStartEnabled, true);
    assert.equal((await post({ action: "auto-start", enabled: false })).status, 422);
    server.onSessionStart({ scenarios: [], spectator: { username: "Observer" }, jobs: 1 });
    assert.equal((await post({ action: "auto-start", enabled: "false" })).status, 400);
    assert.equal((await post({ action: "auto-start", enabled: false })).status, 202);
    const pending = controller.waitForStart("prepared", controller.beginTrial("prepared"));
    assert.equal(server.snapshot().phase, "ready");
    assert.equal(server.snapshot().awaitingStartTrialId, "prepared");
    assert.equal((await post({ action: "start" })).status, 400);
    assert.equal((await post({ action: "start", trialId: "old" })).status, 409);
    assert.equal((await post({ action: "start", trialId: "prepared" })).status, 202);
    await pending;
    assert.equal(server.snapshot().awaitingStartTrialId, null);
    assert.equal(server.snapshot().autoStartEnabled, false);
    assert.equal((await post({ action: "start", trialId: "prepared" })).status, 409);
  } finally { controller.stop(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("parallelism is bounded and changes only between active batches", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-jobs-"));
  const controller = new SessionController();
  const server = await startUiServer({ controller, rootDir: root, port: 0, maxJobs: 4 });
  const change = (jobs: number) => fetch(`http://127.0.0.1:${server.port}/api/control`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "jobs", jobs }),
  });
  try {
    assert.equal((await change(3)).status, 202);
    assert.equal(server.snapshot().jobs, 3);
    assert.equal((await change(5)).status, 422);
    assert.equal((await change(1.5)).status, 400);
    server.onTrialStart({ trialId: "one", sequence: 1, workerIndex: 0, cycle: 1, scenarioIndex: 0,
      scenarioCount: 1, scenario: "example", goalText: "complete", runDir: root, startedAt: new Date().toISOString() });
    assert.equal((await change(1)).status, 409);
    assert.equal(controller.jobs, 3);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("current inspection keeps original conditions and observed child results across catalog refresh and completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-inspect-"));
  const controller = new SessionController();
  const server = await startUiServer({controller,rootDir:root,port:0});
  const scenario = scenarioSchema.parse({name:"example",tags:["regression"],players:[{name:"TestBot"}],client:{command:"bun"},goal:{kind:"all",timeout:60,goals:[{kind:"survive",seconds:20},{kind:"completion"}]}});
  const inspection = inspectScenario("example",scenario);
  try {
    server.onSessionStart({scenarios:[{name:"example",category:"test",inspection}],spectator: { username: "Observer" },jobs:1});
    const scheduler = new TrialScheduler({scenarios:[{scenario}],rootDir:root,controller,log:()=>{}},1);
    const claim = scheduler.claim(0);assert.equal(claim.kind,"trial");
    server.onTrialStart(claim.context);
    const progress: GoalResult = {state:"pending",detail:"all pending",children:[{state:"passed",detail:"alive 20/20s"},{state:"pending",detail:"TestBot has not reported completion"}]};
    server.onGoalProgress(claim.context,progress);
    server.onCatalogChanged([{name:"example",category:"test",inspection:{...inspection,tags:["acceptance"],timeoutSeconds:90}}]);
    const get = (query:string) => fetch(`http://127.0.0.1:${server.port}/api/scenario?${query}`).then(response=>response.json()) as Promise<ScenarioInspection & {progress?:GoalResult;outcome?:string}>;
    const current = await get("current=true");
    assert.equal(current.timeoutSeconds,60);
    assert.deepEqual(current.tags,["regression"]);
    assert.deepEqual((await get("name=example")).tags,["acceptance"]);
    assert.deepEqual(server.snapshot().scenarioTags,{example:["acceptance"]});
    assert.deepEqual(current.progress,progress);
    assert.equal((await get("name=example")).timeoutSeconds,90);
    server.onTrialResult({scenario:"example",outcome:"pass",elapsedMs:21000,goalText:claim.context.goalText,goal:{state:"passed",detail:"all passed",children:[{state:"passed",detail:"alive 20/20s"},{state:"passed",detail:"TestBot completed"}]}},claim.context);
    assert.equal((await get("current=true")).outcome,"pass");
    assert.equal(server.snapshot().currentScenario,"example");
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/scenario?name=missing`)).status,404);
    assert.ok(!JSON.stringify(server.snapshot()).includes("Starting setup"),"full definitions are fetched on demand");
  } finally {await server.close();await rm(root,{recursive:true,force:true});}
});

test("refresh validates edited files atomically and preserves the active connection and history", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-refresh-"));
  const folder = join(root, "fixtures");
  await mkdir(folder);
  const yaml = (seconds: number) => `name: sample\nplayers: [{name: Tester}]\nclient: {command: bun}\ngoal: {kind: survive, seconds: ${seconds}}\n`;
  await writeFile(join(folder, "sample.yaml"), yaml(20));
  const catalog = await loadRunCatalog([folder], "LabSpectator");
  const controller = new SessionController();
  controller.setContinuous(false);
  const summarize = () => catalog.scenarios.map(entry => ({ name: entry.id!, category: entry.category! }));
  const server = await startUiServer({ controller, rootDir: root, port: 0, refreshCatalog: async () => {
    const next = await loadRunCatalog([folder], "LabSpectator");
    catalog.scenarios.splice(0, catalog.scenarios.length, ...next.scenarios);
    return summarize();
  } });
  const refresh = () => fetch(`http://127.0.0.1:${server.port}/api/control`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "refresh" }),
  });
  try {
    server.onSessionStart({ scenarios: summarize(), spectator: { username: "LabSpectator" }, jobs: 1 });
    server.onConnectionChanged({ id: "active", host: "127.0.0.1", port: 29680 });
    const original = catalog.scenarios[0]!;
    await writeFile(join(folder, "sample.yaml"), yaml(30));
    await writeFile(join(folder, "added.yaml"), yaml(10));
    assert.equal((await refresh()).status, 202);
    assert.deepEqual(server.snapshot().scenarios, ["added", "sample"]);
    assert.equal(catalog.scenarios[1]!.scenario.goal.kind, "survive");
    assert.equal((catalog.scenarios[1]!.scenario.goal as { seconds: number }).seconds, 30);
    assert.equal((original.scenario.goal as { seconds: number }).seconds, 20);
    assert.equal(server.snapshot().connection?.id, "active");
    await writeFile(join(folder, "sample.yaml"), "broken: [");
    assert.equal((await refresh()).status, 400);
    assert.deepEqual(server.snapshot().scenarios, ["added", "sample"]);
    assert.equal((catalog.scenarios[1]!.scenario.goal as { seconds: number }).seconds, 30);
    await rm(join(folder, "sample.yaml"));
    assert.equal((await refresh()).status, 202);
    assert.deepEqual(server.snapshot().scenarios, ["added"]);
    const menu = await fetch(`http://127.0.0.1:${server.port}/api/control`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "menu" }),
    });
    assert.equal(menu.status, 202);
    assert.equal(server.snapshot().phase, "returning");
    assert.equal(controller.takeMenuRequest(), true);
    server.onConnectionChanged(null);
    server.onMenu();
    assert.equal(server.snapshot().phase, "paused");
    assert.equal(controller.signal.aborted, false);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("managed catalog and results survive connection replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-managed-ui-"));
  const controller = new SessionController();
  controller.setContinuous(false);
  const server = await startUiServer({ controller, rootDir: root, port: 0 });
  try {
    server.onSessionStart({ scenarios: [{ name: "flat", category: "flat" }, { name: "natural", category: "natural" }],
      spectator: { username: "LabSpectator" }, jobs: 1 });
    assert.equal(server.snapshot().phase, "paused");
    server.onPreparation("Preparing flat world");
    server.onConnectionChanged({ id: "trial-1", host: "127.0.0.1", port: 25680 });
    assert.equal(server.snapshot().phase, "preparing");
    server.onConnectionChanged(null);
    assert.deepEqual(server.snapshot().scenarios, ["flat", "natural"]);
    assert.equal(server.snapshot().connection, null);
    server.onConnectionChanged({ id: "trial-2", host: "127.0.0.1", port: 25680 });
    const snapshot = await fetch(`http://127.0.0.1:${server.port}/api/status`).then((response) => response.json()) as UiSnapshot;
    assert.equal(snapshot.connection?.id, "trial-2", "same port still denotes a new world");
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("UI server loads retained evidence and accepts trial controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-ui-"));
  await writeResult(root, "2026-08-15T01-04-03-004Z-c3-oak-tree", "oak-tree", "cancelled", 500);
  await writeResult(root, "2026-08-15T01-03-03-004Z-c2-sand-single", "sand-single", "fail", 2400);
  await writeResult(root, "2026-08-15T01-02-03-004Z-c1-sand-single", "sand-single", "pass", 1200);
  const controller = new SessionController();
  const server = await startUiServer({
    controller,
    rootDir: root,
    port: 0,
  });

  try {
    server.onSessionStart({
      scenarios: [
        { name: "sand-single", category: "collect" },
        { name: "oak-tree", category: "trees" },
      ],

      jobs: 1,
    });
    const status = await fetch(`http://127.0.0.1:${server.port}/api/status`);
    const snapshot = (await status.json()) as UiSnapshot;
    assert.equal(snapshot.continuousEnabled, true);
    assert.equal(snapshot.singleScenarioEnabled, false);
    assert.equal(snapshot.selectedCategory, null);
    assert.deepEqual(snapshot.categories, [
      { name: "collect", scenarios: ["sand-single"] },
      { name: "trees", scenarios: ["oak-tree"] },
    ]);
    assert.equal(snapshot.recent[0]?.scenario, "oak-tree");
    assert.deepEqual(snapshot.totals, {
      runs: 3,
      passed: 1,
      failed: 1,
      cancelled: 1,
    });
    assert.deepEqual(snapshot.scenarioStats, [
      {
        scenario: "sand-single",
        runs: 2,
        passed: 1,
        failed: 1,
        cancelled: 0,
        averageElapsedMs: 1800,
        recentOutcomes: ["fail", "pass"],
      },
      {
        scenario: "oak-tree",
        runs: 1,
        passed: 0,
        failed: 0,
        cancelled: 1,
        averageElapsedMs: 500,
        recentOutcomes: ["cancelled"],
      },
    ]);

    const trial = controller.beginTrial("trial-1");
    const selection = await fetch(`http://127.0.0.1:${server.port}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "select", scenario: "oak-tree" }),
    });
    assert.equal(selection.status, 202);
    assert.equal(trial.aborted, true);
    assert.equal(controller.takeRequestedScenario(), "oak-tree");
    controller.finishTrial("trial-1", trial);

    const categoryTrial = controller.beginTrial("trial-2");
    const category = await fetch(`http://127.0.0.1:${server.port}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "category", category: "collect" }),
    });
    assert.equal(category.status, 202);
    assert.equal(categoryTrial.aborted, true);
    assert.equal(controller.selectedCategory, "collect");
    assert.equal(controller.takeScheduleChange(), true);
    controller.finishTrial("trial-2", categoryTrial);

    const missingCategory = await fetch(`http://127.0.0.1:${server.port}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "category", category: "missing" }),
    });
    assert.equal(missingCategory.status, 422);

    const invalid = await fetch(`http://127.0.0.1:${server.port}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "select", scenario: "missing" }),
    });
    assert.equal(invalid.status, 422);

    const pause = await fetch(`http://127.0.0.1:${server.port}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "continuous", enabled: false }),
    });
    assert.equal(pause.status, 202);
    assert.equal(controller.continuousEnabled, false);

    const single = await fetch(`http://127.0.0.1:${server.port}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "single", enabled: true }),
    });
    assert.equal(single.status, 202);
    assert.equal(controller.singleScenarioEnabled, true);

    const paused = await fetch(`http://127.0.0.1:${server.port}/api/status`);
    const pausedSnapshot = (await paused.json()) as UiSnapshot;
    assert.equal(pausedSnapshot.phase, "paused");
    assert.equal(pausedSnapshot.continuousEnabled, false);
    assert.equal(pausedSnapshot.singleScenarioEnabled, true);
    assert.equal(pausedSnapshot.selectedCategory, "collect");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("UI statistics use only the latest 15 results", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-ui-window-"));
  for (let index = 0; index < 16; index += 1) {
    const minute = String(index).padStart(2, "0");
    await writeResult(root, `2026-08-15T01-${minute}-03-004Z-c${index + 1}-sand-single`, "sand-single", index === 0 ? "fail" : "pass", 1000);
  }
  const server = await startUiServer({
    controller: new SessionController(),
    rootDir: root,
    port: 0,
  });

  try {
    server.onSessionStart({
      scenarios: [{ name: "sand-single", category: "collect" }],

      jobs: 1,
    });
    const snapshot = server.snapshot();
    assert.deepEqual(snapshot.totals, {
      runs: 15,
      passed: 15,
      failed: 0,
      cancelled: 0,
    });
    assert.deepEqual(snapshot.scenarioStats[0], {
      scenario: "sand-single",
      runs: 15,
      passed: 15,
      failed: 0,
      cancelled: 0,
      averageElapsedMs: 1000,
      recentOutcomes: ["pass", "pass", "pass", "pass", "pass"],
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("UI status exposes the active scenario success condition", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-ui-goal-"));
  const server = await startUiServer({
    controller: new SessionController(),
    rootDir: root,
    port: 0,
  });

  try {
    server.onSessionStart({
      scenarios: [{ name: "sand-single", category: "collect" }],

      jobs: 2,
    });
    const firstContext = {
      trialId: "trial-1",
      sequence: 1,
      workerIndex: 0,
      cycle: 2,
      scenarioIndex: 0,
      scenarioCount: 1,
      scenario: "sand-single",
      goalText: "ALL of:\n  have 1× sand\n  first player reports successful completion",
      runDir: join(root, "runs", "active"),
      startedAt: "2026-08-18T01:02:03.004Z",
    };
    const secondContext = {
      ...firstContext,
      trialId: "trial-2",
      sequence: 2,
      workerIndex: 1,
      scenario: "oak-tree",
      runDir: join(root, "runs", "active-2"),
    };
    server.onTrialStart(firstContext);
    server.onTrialStart(secondContext);

    const response = await fetch(`http://127.0.0.1:${server.port}/api/status`);
    const snapshot = (await response.json()) as UiSnapshot;
    assert.equal(snapshot.active?.scenario, "sand-single");
    assert.equal(snapshot.active?.goalText, "ALL of:\n  have 1× sand\n  first player reports successful completion");
    assert.deepEqual(snapshot.activeTrials.map(({ trialId }) => trialId), ["trial-1", "trial-2"]);

    server.onTrialResult({
      scenario: "sand-single",
      outcome: "pass",
      elapsedMs: 1000,
      goal: { state: "passed", detail: "done" },
      goalText: "done",
    }, firstContext);
    const remaining = server.snapshot();
    assert.equal(remaining.phase, "running");
    assert.equal(remaining.active?.trialId, "trial-2");
    assert.deepEqual(remaining.activeTrials.map(({ trialId }) => trialId), ["trial-2"]);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("UI server closes immediately even with active keep-alive client connections", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-ui-close-"));
  const controller = new SessionController();
  const server = await startUiServer({
    controller,
    rootDir: root,
    port: 0,
  });

  try {
    // Open a persistent connection
    const res = await fetch(`http://127.0.0.1:${server.port}/api/status`, {
      headers: { Connection: "keep-alive" },
    });
    assert.equal(res.status, 200);

    const closeStart = Date.now();
    await server.close();
    assert.ok(Date.now() - closeStart < 2000, "close() should settle promptly without waiting for socket timeouts");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function writeResult(root: string, directory: string, scenario: string, outcome: "pass" | "fail" | "cancelled", elapsedMs: number): Promise<void> {
  const run = join(root, "runs", directory);
  await mkdir(run, { recursive: true });
  await writeFile(
    join(run, "results.json"),
    JSON.stringify({
      scenario,
      outcome,
      elapsedMs,
      goal: {
        state: outcome === "pass" ? "passed" : "failed",
        detail: `${scenario}: ${outcome}`,
      },
    }),
  );
}

test("Keep running API toggles preserve the menu until a scenario is selected", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-repeat-toggle-"));
  const controller = new SessionController();
  controller.setContinuous(false);
  const server = await startUiServer({ controller, rootDir: root, port: 0 });
  const post = (body: object) => fetch(`http://127.0.0.1:${server.port}/api/control`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    server.onSessionStart({ scenarios: [{ name: "first", category: "test" }, { name: "chosen", category: "test" }], spectator: { username: "Observer" }, jobs: 1 });
    for (const enabled of [true, false, true]) {
      assert.equal((await post({ action: "continuous", enabled })).status, 202);
      assert.equal(server.snapshot().continuousEnabled, enabled);
      assert.equal(server.snapshot().phase, "paused");
      assert.equal(server.snapshot().connection, null);
      assert.equal(controller.canRepeat, false);
    }
    assert.equal((await post({ action: "select", scenario: "chosen" })).status, 202);
    assert.equal(controller.takeRequestedScenario(), "chosen");
    assert.equal(controller.canRepeat, true);
    assert.equal(server.snapshot().phase, "preparing");
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
