import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionController } from "../session/controller.js";
import { startUiServer, type UiServerOptions, type UiSnapshot } from "./server.js";
import { loadRunCatalog } from "../scenario/catalog.js";
import { inspectScenario } from "../scenario/inspection.js";
import { scenarioSchema } from "../scenario/schema.js";
import { TrialScheduler, type TrialContext } from "../session/run.js";
import type { GoalResult } from "../trial/goals.js";
import type { ScenarioInspection } from "../scenario/inspection.js";

/** A fresh evidence root, removed when the test ends. */
async function tempRoot(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * A UI server on an ephemeral port, stopped and closed when the test ends, with
 * the HTTP calls the client mod makes. Pass `rootDir` to start over retained
 * evidence written beforehand.
 */
async function startLab(t: TestContext, options: Partial<UiServerOptions> = {}) {
  const root = options.rootDir ?? await tempRoot(t, "mine-labs-ui-");
  const controller = options.controller ?? new SessionController();
  const server = await startUiServer({ port: 0, ...options, controller, rootDir: root });
  t.after(async () => { controller.stop(); await server.close(); });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    root, controller, server, base,
    post: (body: object) => fetch(`${base}/api/control`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
    status: async (headers: Record<string, string> = {}) => await (await fetch(`${base}/api/status`, { headers })).json() as UiSnapshot,
  };
}

function trialContext(context: Pick<TrialContext, "trialId" | "scenario"> & Partial<TrialContext>): TrialContext {
  return { sequence: 1, workerIndex: 0, cycle: 1, scenarioIndex: 0, scenarioCount: 1, goalText: "complete",
    runDir: "", startedAt: new Date().toISOString(), ...context };
}

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

test("manual start API reports ready and rejects stale or malformed start requests", async (t) => {
  const { server, controller, post } = await startLab(t);
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
});

test("parallelism is bounded and changes only between active batches", async (t) => {
  const { server, controller, root, post } = await startLab(t, { maxJobs: 4 });
  const change = (jobs: number) => post({ action: "jobs", jobs });
  assert.equal((await change(3)).status, 202);
  assert.equal(server.snapshot().jobs, 3);
  assert.equal((await change(5)).status, 422);
  assert.equal((await change(1.5)).status, 400);
  server.onTrialStart(trialContext({ trialId: "one", scenario: "example", runDir: root }));
  assert.equal((await change(1)).status, 409);
  assert.equal(controller.jobs, 3);
});

test("current inspection keeps original conditions and observed child results across catalog refresh and completion", async (t) => {
  const { server, controller, root, base } = await startLab(t);
  const scenario = scenarioSchema.parse({ name: "example", tags: ["regression"], players: [{ name: "TestBot" }], client: { command: "bun" },
    goal: { kind: "all", timeout: 60, goals: [{ kind: "survive", seconds: 20 }, { kind: "completion" }] } });
  const inspection = inspectScenario("example", scenario);
  server.onSessionStart({ scenarios: [{ name: "example", category: "test", inspection }], spectator: { username: "Observer" }, jobs: 1 });
  const scheduler = new TrialScheduler({ scenarios: [{ scenario }], rootDir: root, controller, log: () => {} }, 1);
  const claim = scheduler.claim(0);
  assert.equal(claim.kind, "trial");
  server.onTrialStart(claim.context);
  const progress: GoalResult = { state: "pending", detail: "all pending",
    children: [{ state: "passed", detail: "alive 20/20s" }, { state: "pending", detail: "TestBot has not reported completion" }] };
  server.onGoalProgress(claim.context, progress);
  server.onCatalogChanged([{ name: "example", category: "test", inspection: { ...inspection, tags: ["acceptance"], timeoutSeconds: 90 } }]);
  const get = (query: string) => fetch(`${base}/api/scenario?${query}`)
    .then(response => response.json()) as Promise<ScenarioInspection & { progress?: GoalResult; outcome?: string }>;
  const current = await get("current=true");
  assert.equal(current.timeoutSeconds, 60);
  assert.deepEqual(current.tags, ["regression"]);
  assert.deepEqual((await get("name=example")).tags, ["acceptance"]);
  assert.deepEqual(server.snapshot().scenarioTags, { example: ["acceptance"] });
  assert.deepEqual(current.progress, progress);
  assert.equal((await get("name=example")).timeoutSeconds, 90);
  server.onTrialResult({ scenario: "example", outcome: "pass", elapsedMs: 21000, goalText: claim.context.goalText,
    goal: { state: "passed", detail: "all passed", children: [{ state: "passed", detail: "alive 20/20s" }, { state: "passed", detail: "TestBot completed" }] } }, claim.context);
  assert.equal((await get("current=true")).outcome, "pass");
  assert.equal(server.snapshot().currentScenario, "example");
  assert.equal((await fetch(`${base}/api/scenario?name=missing`)).status, 404);
  assert.ok(!JSON.stringify(server.snapshot()).includes("Starting setup"), "full definitions are fetched on demand");
});

test("refresh validates edited files atomically and preserves the active connection and history", async (t) => {
  const root = await tempRoot(t, "mine-labs-refresh-");
  const folder = join(root, "fixtures");
  await mkdir(folder);
  const yaml = (seconds: number) => `name: sample\nplayers: [{name: Tester}]\nclient: {command: bun}\ngoal: {kind: survive, seconds: ${seconds}}\n`;
  await writeFile(join(folder, "sample.yaml"), yaml(20));
  const catalog = await loadRunCatalog([folder], "LabSpectator");
  const controller = new SessionController();
  controller.setContinuous(false);
  const summarize = () => catalog.scenarios.map(entry => ({ name: entry.id!, category: entry.category! }));
  const { server, post } = await startLab(t, { controller, rootDir: root, refreshCatalog: async () => {
    const next = await loadRunCatalog([folder], "LabSpectator");
    catalog.scenarios.splice(0, catalog.scenarios.length, ...next.scenarios);
    return summarize();
  } });
  const refresh = () => post({ action: "refresh" });
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
  assert.equal((await post({ action: "menu" })).status, 202);
  assert.equal(server.snapshot().phase, "returning");
  assert.equal(controller.takeMenuRequest(), true);
  server.onConnectionChanged(null);
  server.onMenu();
  assert.equal(server.snapshot().phase, "paused");
  assert.equal(controller.signal.aborted, false);
});

test("managed catalog and results survive connection replacement", async (t) => {
  const controller = new SessionController();
  controller.setContinuous(false);
  const { server, status } = await startLab(t, { controller });
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
  assert.equal((await status()).connection?.id, "trial-2", "same port still denotes a new world");
});

test("UI server loads retained evidence and accepts trial controls", async (t) => {
  const root = await tempRoot(t, "mine-labs-ui-");
  await writeResult(root, "2026-08-15T01-04-03-004Z-c3-oak-tree", "oak-tree", "cancelled", 500);
  await writeResult(root, "2026-08-15T01-03-03-004Z-c2-sand-single", "sand-single", "fail", 2400);
  await writeResult(root, "2026-08-15T01-02-03-004Z-c1-sand-single", "sand-single", "pass", 1200);
  const { server, controller, post, status } = await startLab(t, { rootDir: root });
  server.onSessionStart({
    scenarios: [
      { name: "sand-single", category: "collect" },
      { name: "oak-tree", category: "trees" },
    ],
    jobs: 1,
  });
  const snapshot = await status();
  assert.equal(snapshot.continuousEnabled, true);
  assert.equal(snapshot.singleScenarioEnabled, false);
  assert.equal(snapshot.selectedCategory, null);
  assert.deepEqual(snapshot.categories, [
    { name: "collect", scenarios: ["sand-single"] },
    { name: "trees", scenarios: ["oak-tree"] },
  ]);
  assert.equal(snapshot.recent[0]?.scenario, "oak-tree");
  assert.deepEqual(snapshot.totals, { runs: 3, passed: 1, failed: 1, cancelled: 1 });
  assert.deepEqual(snapshot.scenarioStats, [
    { scenario: "sand-single", runs: 2, passed: 1, failed: 1, cancelled: 0, averageElapsedMs: 1800, recentOutcomes: ["fail", "pass"] },
    { scenario: "oak-tree", runs: 1, passed: 0, failed: 0, cancelled: 1, averageElapsedMs: 500, recentOutcomes: ["cancelled"] },
  ]);

  const trial = controller.beginTrial("trial-1");
  assert.equal((await post({ action: "select", scenario: "oak-tree" })).status, 202);
  assert.equal(trial.aborted, true);
  assert.equal(controller.takeRequestedScenario(), "oak-tree");
  controller.finishTrial("trial-1", trial);

  const categoryTrial = controller.beginTrial("trial-2");
  assert.equal((await post({ action: "category", category: "collect" })).status, 202);
  assert.equal(categoryTrial.aborted, true);
  assert.equal(controller.selectedCategory, "collect");
  assert.equal(controller.takeScheduleChange(), true);
  controller.finishTrial("trial-2", categoryTrial);

  assert.equal((await post({ action: "category", category: "missing" })).status, 422);
  assert.equal((await post({ action: "select", scenario: "missing" })).status, 422);

  assert.equal((await post({ action: "continuous", enabled: false })).status, 202);
  assert.equal(controller.continuousEnabled, false);

  assert.equal((await post({ action: "single", enabled: true })).status, 202);
  assert.equal(controller.singleScenarioEnabled, true);

  const pausedSnapshot = await status();
  assert.equal(pausedSnapshot.phase, "paused");
  assert.equal(pausedSnapshot.continuousEnabled, false);
  assert.equal(pausedSnapshot.singleScenarioEnabled, true);
  assert.equal(pausedSnapshot.selectedCategory, "collect");
});

test("UI statistics use only the latest 15 results", async (t) => {
  const root = await tempRoot(t, "mine-labs-ui-window-");
  for (let index = 0; index < 16; index += 1) {
    const minute = String(index).padStart(2, "0");
    await writeResult(root, `2026-08-15T01-${minute}-03-004Z-c${index + 1}-sand-single`, "sand-single", index === 0 ? "fail" : "pass", 1000);
  }
  const { server } = await startLab(t, { rootDir: root });
  server.onSessionStart({ scenarios: [{ name: "sand-single", category: "collect" }], jobs: 1 });
  const snapshot = server.snapshot();
  assert.deepEqual(snapshot.totals, { runs: 15, passed: 15, failed: 0, cancelled: 0 });
  assert.deepEqual(snapshot.scenarioStats[0], {
    scenario: "sand-single",
    runs: 15,
    passed: 15,
    failed: 0,
    cancelled: 0,
    averageElapsedMs: 1000,
    recentOutcomes: ["pass", "pass", "pass", "pass", "pass"],
  });
});

test("UI status exposes the active scenario success condition", async (t) => {
  const { server, root, status } = await startLab(t);
  server.onSessionStart({ scenarios: [{ name: "sand-single", category: "collect" }], jobs: 2 });
  const firstContext = trialContext({
    trialId: "trial-1",
    cycle: 2,
    scenario: "sand-single",
    goalText: "ALL of:\n  have 1× sand\n  first player reports successful completion",
    runDir: join(root, "runs", "active"),
    startedAt: "2026-08-18T01:02:03.004Z",
  });
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

  const snapshot = await status();
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
});

test("UI server closes immediately even with active keep-alive client connections", async (t) => {
  const { server, base } = await startLab(t);
  // Open a persistent connection
  const res = await fetch(`${base}/api/status`, { headers: { Connection: "keep-alive" } });
  assert.equal(res.status, 200);

  const closeStart = Date.now();
  await server.close();
  assert.ok(Date.now() - closeStart < 2000, "close() should settle promptly without waiting for socket timeouts");
  // The test's cleanup closes it again, which must also be harmless.
});

test("routes match on the path, so a query string does not hide them", async (t) => {
  const { base } = await startLab(t);
  assert.equal((await fetch(`${base}/api/status?poll=1`)).status, 200);
  assert.equal(((await (await fetch(`${base}/?from=browser`)).json()) as { service: string }).service, "mine-labs-ui");
  const control = await fetch(`${base}/api/control?source=test`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "skip" }),
  });
  assert.equal(control.status, 202);
  assert.equal((await fetch(`${base}/api/control`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await fetch(`${base}/api/missing`)).status, 404);
});

test("Keep running API toggles preserve the menu until a scenario is selected", async (t) => {
  const controller = new SessionController();
  controller.setContinuous(false);
  const { server, post } = await startLab(t, { controller });
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
});

test("Tailscale remote mode identifies the watching player and serves its mods and properties", async (t) => {
  const root = await tempRoot(t, "mine-labs-remote-");
  const jar = join(root, "viewer.jar");
  await writeFile(jar, "jar bytes");
  const { server, base, status } = await startLab(t, { rootDir: root, remote: {
    downloads: [{ name: "mine-labs-spectator-viewer.jar", path: jar }],
    clientProperties: { "viewer.portOffset": "10000" },
  } });
  const arrived = server.waitForSpectatorName();
  await fetch(`${base}/api/status`, { headers: { "x-mine-labs-player": "not a name!" } });
  assert.equal(server.spectatorName, undefined);
  const snapshot = await status({ "x-mine-labs-player": "PhoneSteve" });
  assert.equal(await arrived, "PhoneSteve");
  assert.deepEqual(snapshot.clientProperties, { "viewer.portOffset": "10000" });
  const page = await fetch(`${base}/`, { headers: { accept: "text/html" } });
  assert.match(page.headers.get("content-type") ?? "", /text\/html/u);
  assert.match(await page.text(), /\/downloads\/mine-labs-spectator-viewer\.jar/u);
  // `/setup` answers with the page even without asking for HTML, and shows the address to copy.
  const setup = await (await fetch(`${base}/setup`)).text();
  assert.match(setup, new RegExp(`value="${base.replaceAll(".", "\\.")}"`, "u"));
  assert.match(setup, /id="copy-address"/u);
  assert.match(setup, /9 B/u);
  assert.equal(server.setupUrl, `${base}/setup`);
  const download = await fetch(`${base}/downloads/mine-labs-spectator-viewer.jar`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "jar bytes");
  assert.equal((await fetch(`${base}/downloads/other.jar`)).status, 404);
});

test("a loopback lab neither identifies players nor serves downloads", async (t) => {
  const { server, base, status } = await startLab(t);
  const snapshot = await status({ "x-mine-labs-player": "PhoneSteve" });
  assert.equal(server.spectatorName, undefined);
  assert.equal(snapshot.clientProperties, undefined);
  assert.equal((await fetch(`${base}/downloads/mine-labs-ui.jar`)).status, 404);
  assert.equal((await fetch(`${base}/setup`)).status, 404);
});
