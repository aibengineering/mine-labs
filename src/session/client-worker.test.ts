import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scenarioSchema } from "../scenario/schema.js";
import { delay } from "../util/fs.js";
import type { RunResult } from "../trial/run.js";
import { createClientSessionWorker } from "./client-worker.js";
import { SessionController } from "./controller.js";
import type { SessionScenario, TrialContext } from "./run.js";
import type { createSessionWorker } from "./worker.js";

test("one prepared successor waits for selection, preserves evidence, and closes both servers", async () => {
  const harness = await createHarness();
  try {
    harness.next = entry("b");
    const first = harness.worker.runTrial(entry("a"), harness.context("a", 1));
    await until(() => harness.servers.length === 2 && harness.servers[1]!.prepared);
    assert.deepEqual(harness.started, ["a"]);
    assert.deepEqual(harness.connections, ["a"]);
    harness.servers[0]!.finish.resolve();
    assert.equal((await first).outcome, "pass");
    assert.equal(await readFile(join(harness.root, "run-1", "artifacts", "evidence.txt"), "utf8"), "a");
    const secondEntry = harness.next;
    harness.next = undefined;
    const second = harness.worker.runTrial(secondEntry, harness.context("b", 2));
    await until(() => harness.started.length === 2);
    assert.equal(harness.servers.length, 2, "adopts the already prepared server");
    assert.deepEqual(harness.connections, ["a", "b"]);
    harness.servers[1]!.finish.resolve();
    await second;
    await harness.worker.close();
    assert.ok(harness.servers.every(server => server.closed));
  } finally { await harness.close(); }
});

test("changed settings discard stale preparation before booting its replacement", async () => {
  const harness = await createHarness();
  try {
    harness.next = entry("b");
    const first = harness.worker.runTrial(entry("a"), harness.context("a", 1));
    await until(() => harness.servers.length === 2 && harness.servers[1]!.prepared);
    harness.next = entry("c");
    harness.worker.refresh();
    await until(() => harness.servers.length === 3 && harness.servers[2]!.prepared);
    assert.ok(harness.servers[1]!.closed);
    assert.deepEqual(harness.started, ["a"]);
    harness.next = undefined; // Keep running was turned off.
    harness.worker.refresh();
    await until(() => harness.servers[2]!.closed);
    harness.servers[0]!.finish.resolve();
    await first;
    assert.equal(harness.maxAlive, 2);
  } finally { await harness.close(); }
});

test("a cold selection keeps the completed world connected until the replacement is ready", async () => {
  const harness = await createHarness();
  const gate = Promise.withResolvers<void>();
  try {
    const first = harness.worker.runTrial(entry("a"), harness.context("a", 1));
    await until(() => harness.started.length === 1);
    harness.servers[0]!.finish.resolve();
    await first;
    harness.holdConnection = gate.promise;
    const second = harness.worker.runTrial(entry("b"), harness.context("b", 2));
    await until(() => harness.servers.length === 2 && harness.servers[1]!.prepared);
    assert.equal(harness.connected, "a");
    assert.equal(harness.servers[0]!.closed, false);
    gate.resolve();
    await until(() => harness.started.length === 2);
    harness.servers[1]!.finish.resolve();
    await second;
    assert.equal(harness.connected, "b");
  } finally { gate.resolve(); await harness.close(); }
});

test("shutdown during preparation cancels the gate and a failed standby retries only when selected", async () => {
  const harness = await createHarness();
  try {
    harness.next = entry("broken");
    const first = harness.worker.runTrial(entry("a"), harness.context("a", 1));
    await until(() => harness.servers.length === 2 && harness.servers[1]!.finished);
    harness.servers[0]!.finish.resolve();
    await first;
    const secondEntry = harness.next;
    harness.next = undefined;
    const second = harness.worker.runTrial(secondEntry, harness.context("broken", 2));
    assert.equal((await second).outcome, "error");
    assert.equal(harness.servers.length, 3);
    assert.ok(harness.servers[1]!.closed);
    harness.next = entry("d");
    const third = harness.worker.runTrial(entry("c"), harness.context("c", 3));
    await until(() => harness.servers.length === 5 && harness.servers[4]!.prepared);
    await harness.worker.close();
    assert.equal((await third).outcome, "cancelled");
    assert.ok(harness.servers.every(server => server.closed));
    assert.equal(harness.maxAlive, 2);
  } finally { await harness.close(); }
});

test("manual start connects the observer but holds execution; closing cancels the hold", async () => {
  const harness = await createHarness();
  try {
    harness.controller.setAutoStart(false);
    const first = harness.worker.runTrial(entry("a"), harness.context("a", 1));
    await until(() => harness.controller.awaitingStartTrialId === "trial-1");
    assert.equal(harness.connected, "a");
    assert.deepEqual(harness.started, []);
    harness.controller.startPreparedTrial("trial-1");
    await until(() => harness.started.length === 1);
    harness.servers[0]!.finish.resolve();
    await first;
    const second = harness.worker.runTrial(entry("b"), harness.context("b", 2));
    await until(() => harness.controller.awaitingStartTrialId === "trial-2");
    await harness.worker.close();
    await second;
    assert.deepEqual(harness.started, ["a"]);
    assert.equal(harness.controller.awaitingStartTrialId, undefined);
  } finally { await harness.close(); }
});

function entry(name: string): SessionScenario {
  return { scenario: scenarioSchema.parse({ name, players: [{ name: "Tester" }],
    client: { command: "unused" }, goal: { kind: "completion" } }) };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "lifecycle transition timed out");
    await delay(5);
  }
}

async function createHarness() {
  const controller = new SessionController();
  const root = await mkdtemp(join(tmpdir(), "mine-labs-lookahead-"));
  const servers: Array<{ prepared: boolean; finished: boolean; closed: boolean; finish: ReturnType<typeof Promise.withResolvers<void>> }> = [];
  const started: string[] = [];
  const connections: string[] = [];
  let next: SessionScenario | undefined;
  let holdConnection: Promise<void> | undefined;
  let connected: string | undefined;
  let maxAlive = 0;
  const createWorker: typeof createSessionWorker = options => {
    const connectionGate = holdConnection;
    const state = { prepared: false, finished: false, closed: false, finish: Promise.withResolvers<void>() };
    servers.push(state);
    maxAlive = Math.max(maxAlive, servers.filter(server => !server.closed).length);
    let result: Promise<RunResult>;
    return {
      runTrial(entry, context, signal, preparation) {
        result = (async () => {
          const abort = Promise.withResolvers<void>();
          const cancel = () => abort.resolve();
          signal?.addEventListener("abort", cancel, { once: true });
          if (signal?.aborted) cancel();
          try {
            await mkdir(join(context.runDir, "artifacts"), { recursive: true });
            options.observer?.onConnectionChanged?.(null);
            await writeFile(join(context.runDir, "artifacts", "evidence.txt"), entry.scenario.name!);
            assert.equal(preparation?.holdPreparedWorld, true);
            state.prepared = true;
            if (entry.scenario.name === "broken") throw new Error("preparation failed");
            await Promise.race([preparation?.onWorldPrepared?.(), abort.promise]);
            if (connectionGate) await Promise.race([connectionGate, abort.promise]);
            if (!signal?.aborted) {
              options.observer?.onConnectionChanged?.({ id: entry.scenario.name!, host: "127.0.0.1", port: 12345 });
              await options.observer?.onTrialRunning?.(context);
              await Promise.race([state.finish.promise, abort.promise]);
            }
            return { scenario: entry.scenario.name!, outcome: signal?.aborted ? "cancelled" : "pass", elapsedMs: 1,
              goal: { state: "passed", detail: "done" }, goalText: "completion" } as RunResult;
          } catch {
            return { scenario: entry.scenario.name!, outcome: "error", elapsedMs: 1,
              goal: { state: "pending", detail: "failed" }, goalText: "completion" } as RunResult;
          } finally {
            state.finished = true;
            signal?.removeEventListener("abort", cancel);
          }
        })();
        return result;
      },
      async close() { await result; state.closed = true; },
    };
  };
  const worker = createClientSessionWorker({ rootDir: root, scenarios: [], controller, spectator: { username: "Observer" }, log: () => {},
    observer: {
      onConnectionChanged: connection => { connected = connection?.id; if (connection) connections.push(connection.id); },
      onTrialRunning: context => { started.push(context.scenario); },
    },
  }, join(root, "servers"), () => next, createWorker);
  return {
    worker, controller, servers, started, connections, root,
    get next() { return next; }, set next(entry: SessionScenario | undefined) { next = entry; },
    set holdConnection(gate: Promise<void>) { holdConnection = gate; },
    get connected() { return connected; },
    get maxAlive() { return maxAlive; },
    context(name: string, sequence: number): TrialContext {
      return { trialId: `trial-${sequence}`, sequence, workerIndex: 0, cycle: 1, scenarioIndex: sequence - 1,
        scenarioCount: 3, scenario: name, goalText: "completion", runDir: join(root, `run-${sequence}`), startedAt: new Date().toISOString() };
    },
    async close() { await worker.close(); await rm(root, { recursive: true, force: true }); },
  };
}
