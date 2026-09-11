import assert from "node:assert/strict";
import test from "node:test";
import { advanceSchedule, TrialScheduler, type SessionScenario } from "./run.js";
import { SessionController } from "./controller.js";
import { scenarioSchema } from "../scenario/schema.js";

test("catalog replacement changes the next claim while the active trial retains its setup", () => {
  const controller = new SessionController();
  controller.setContinuous(false);
  const entries = [scenario("old")];
  const scheduler = createScheduler(entries, Infinity, controller);
  controller.selectScenario("old");
  const active = scheduler.claim(0);
  assert.equal(active.kind, "trial");
  entries.splice(0, entries.length, scenario("new"));
  controller.reconcileCatalog(["new"], ["test"]);
  controller.returnToMenu();
  assert.deepEqual(scheduler.claim(0), { kind: "menu" });
  assert.deepEqual(scheduler.claim(0), { kind: "wait" });
  controller.selectScenario("new");
  const next = scheduler.claim(0);
  assert.equal(next.kind, "trial");
  assert.equal(next.entry.scenario.name, "new");
  assert.equal(active.entry.scenario.name, "old");
});

test("suite mode advances through scenarios before incrementing the cycle", () => {
  assert.deepEqual(advanceSchedule(1, 0, 3, false), { cycle: 1, scenarioIndex: 1 });
  assert.deepEqual(advanceSchedule(1, 2, 3, false), { cycle: 2, scenarioIndex: 0 });
});

test("single-scenario mode repeats the selected scenario and counts each run as a cycle", () => {
  assert.deepEqual(advanceSchedule(4, 1, 3, true), { cycle: 5, scenarioIndex: 1 });
});

test("parallel workers claim distinct trials from the same cycle", () => {
  const scheduler = createScheduler([scenario("sand-single"), scenario("oak-tree")], 1);

  const first = scheduler.claim(0);
  const second = scheduler.claim(1);
  const complete = scheduler.claim(0);

  assert.equal(first.kind, "trial");
  assert.equal(second.kind, "trial");
  assert.equal(complete.kind, "complete");
  assert.equal(first.context.scenario, "sand-single");
  assert.equal(second.context.scenario, "oak-tree");
  assert.equal(first.context.cycle, 1);
  assert.equal(second.context.cycle, 1);
  assert.notEqual(first.context.trialId, second.context.trialId);
  assert.notEqual(first.context.runDir, second.context.runDir);
  assert.equal(first.context.workerIndex, 0);
  assert.equal(second.context.workerIndex, 1);
});

test("a paused scheduler grants exactly one trial with one configured worker", () => {
  const controller = new SessionController();
  controller.setContinuous(false);
  const scheduler = createScheduler([scenario("sand-single"), scenario("oak-tree")], 2, controller);

  assert.equal(scheduler.claim(0).kind, "wait");
  controller.selectScenario("oak-tree");
  const selected = scheduler.claim(0);
  assert.equal(selected.kind, "trial");
  assert.equal(selected.context.scenario, "oak-tree");
  assert.equal(scheduler.claim(1).kind, "wait");
});

test("client selection runs one copy per worker, then pauses", () => {
  const controller = new SessionController();
  controller.setJobs(3);
  controller.setContinuous(false);
  const scheduler = createScheduler([scenario("a"), scenario("b")], Infinity, controller);
  controller.selectScenario("b");
  for (let worker = 0; worker < 3; worker++) {
    const claim = scheduler.claim(worker);
    assert.equal(claim.kind, "trial");
    assert.equal(claim.context.scenario, "b");
  }
  assert.equal(scheduler.claim(0).kind, "wait");
});

test("running a folder while paused visits every entry exactly once", () => {
  const controller = new SessionController();
  controller.setContinuous(false);
  controller.setSingleScenario(true); // This preference applies only when Keep running is on.
  const scheduler = createScheduler([scenario("a"), scenario("b"), scenario("c")], Infinity, controller);
  controller.selectCategory("test");
  for (const name of ["a", "b", "c"]) {
    const claim = scheduler.claim(0);
    assert.equal(claim.kind, "trial");
    assert.equal(claim.context.scenario, name);
  }
  assert.equal(scheduler.claim(0).kind, "wait");
});

test("turning Keep running off drops unclaimed folder work after active trials", () => {
  const controller = new SessionController();
  const scheduler = createScheduler([scenario("a"), scenario("b")], Infinity, controller);
  controller.selectCategory("test");
  assert.equal(scheduler.claim(0).kind, "trial");
  controller.setContinuous(false);
  assert.equal(scheduler.claim(0).kind, "wait");
});

test("single-scenario parallel claims count each simultaneous run as a cycle", () => {
  const controller = new SessionController();
  controller.setSingleScenario(true);
  const scheduler = createScheduler([scenario("sand-single")], 2, controller);

  const first = scheduler.claim(0);
  const second = scheduler.claim(1);

  assert.equal(first.kind, "trial");
  assert.equal(second.kind, "trial");
  assert.equal(first.context.cycle, 1);
  assert.equal(second.context.cycle, 2);
  assert.equal(scheduler.claim(0).kind, "complete");
});

function scenario(name: string): SessionScenario {
  return {
    category: "test",
    scenario: scenarioSchema.parse({
      name,
      world: { type: "flat" },
      players: [{ name: "Tester" }],
      client: { command: "node", args: [] },
      goal: { kind: "completion" },
    }),
  };
}

test("catalog selections distinguish equal scenario names without changing the client input", () => {
  const controller = new SessionController();
  controller.setContinuous(false);
  const first = { ...scenario("same"), id: "flat/same" };
  const second = { ...scenario("same"), id: "natural/same" };
  const scheduler = createScheduler([first, second], 1, controller);
  controller.selectScenario("natural/same");
  const selected = scheduler.claim(0);
  assert.equal(selected.kind, "trial");
  assert.equal(selected.context.scenario, "natural/same");
  assert.equal(selected.entry.scenario.name, "same");
});

function createScheduler(
  scenarios: SessionScenario[],
  cycles: number,
  controller?: SessionController,
): TrialScheduler {
  return new TrialScheduler({
    scenarios,
    rootDir: ".mine-labs/test-scheduler",

    log: () => undefined,
    controller,
  }, cycles);
}

test("lookahead does not consume selections, folder permits, or cycle bounds", () => {
  const entries = [scenario("a"), scenario("b"), scenario("c")];
  for (const mode of ["suite", "single", "folder", "selection"] as const) {
    const controller = new SessionController();
    controller.setContinuous(mode === "suite" || mode === "single");
    controller.setSingleScenario(mode === "single");
    if (mode === "folder") controller.selectCategory("test");
    if (mode === "selection") controller.selectScenario("b");
    const scheduler = createScheduler(entries, 2, controller);
    let count = 0;
    for (;;) {
      const next = scheduler.peek();
      assert.equal(scheduler.peek(), next);
      const claim = scheduler.claim(count % 2);
      if (claim.kind !== "trial") {
        assert.equal(next, undefined);
        break;
      }
      assert.equal(next, claim.entry);
      assert.equal(claim.context.sequence, ++count);
    }
    assert.equal(count, { suite: 6, single: 2, folder: 3, selection: 1 }[mode]);
  }
});

test("lookahead follows live controls and catalog replacement", () => {
  const entries = [scenario("a"), scenario("b")];
  const controller = new SessionController();
  const scheduler = createScheduler(entries, Infinity, controller);
  scheduler.claim(0);
  assert.equal(scheduler.peek(), entries[1]);
  controller.selectScenario("a");
  assert.equal(scheduler.peek(), entries[0]);
  entries.splice(0, entries.length, scenario("new"));
  controller.reconcileCatalog(["new"], ["test"]);
  assert.equal(scheduler.peek(), entries[0]);
  controller.returnToMenu();
  assert.equal(scheduler.peek(), undefined);
  assert.equal(scheduler.claim(0).kind, "menu");
  assert.equal(scheduler.peek(), undefined);
});

test("enabling single during a running selected scenario repeats that scenario, not the next slot", () => {
  const controller = new SessionController();
  const scheduler = createScheduler([scenario("bow"), scenario("mixed"), scenario("perch")], Infinity, controller);
  controller.selectScenario("mixed");
  const current = scheduler.claim(0);
  assert.equal(current.kind, "trial");
  assert.equal(current.context.scenario, "mixed");
  controller.setSingleScenario(true);
  assert.equal(scheduler.peek()?.scenario.name, "mixed");
  for (let i = 0; i < 3; i++) {
    const next = scheduler.claim(0);
    assert.equal(next.kind, "trial");
    assert.equal(next.context.scenario, "mixed");
  }
});

test("enabling single with parallel workers retains each worker's actual scenario", () => {
  const controller = new SessionController();
  controller.setJobs(2);
  const scheduler = createScheduler([scenario("mixed"), scenario("perch"), scenario("full")], Infinity, controller);
  scheduler.claim(0);
  scheduler.claim(1);
  controller.setSingleScenario(true);
  for (const [worker, name] of [[0, "mixed"], [1, "perch"], [0, "mixed"], [1, "perch"]] as const) {
    const next = scheduler.claim(worker);
    assert.equal(next.kind, "trial");
    assert.equal(next.context.scenario, name);
  }
});
