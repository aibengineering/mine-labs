import assert from "node:assert/strict";
import test from "node:test";
import { SessionController } from "./controller.js";

test("auto-start defaults on; manual starts only release the matching prepared trial", async () => {
  const controller = new SessionController();
  const signal = controller.beginTrial("first");
  assert.equal(controller.autoStartEnabled, true);
  await controller.waitForStart("first", signal);
  assert.equal(controller.awaitingStartTrialId, undefined);
  controller.setAutoStart(false);
  let started = false;
  const pending = controller.waitForStart("first", signal).then(() => { started = true; });
  await Promise.resolve();
  assert.equal(started, false);
  assert.equal(controller.startPreparedTrial("old"), false);
  assert.equal(controller.startPreparedTrial("first"), true);
  await pending;
  assert.equal(controller.autoStartEnabled, false, "starting once preserves the preference");
  assert.equal(controller.startPreparedTrial("first"), false);
  const next = controller.waitForStart("second", controller.beginTrial("second"));
  assert.equal(controller.startPreparedTrial("first"), false, "stale clicks cannot start the next trial");
  controller.setAutoStart(true);
  await next;
  assert.equal(controller.awaitingStartTrialId, undefined);
});

test("skip, menu, selection and stop cancel a pending start without leaking its permit", async () => {
  for (const cancel of [
    (controller: SessionController) => controller.skip(),
    (controller: SessionController) => controller.returnToMenu(),
    (controller: SessionController) => controller.selectScenario("next"),
    (controller: SessionController) => controller.stop(),
  ]) {
    const controller = new SessionController();
    controller.setAutoStart(false);
    const signal = controller.beginTrial("waiting");
    const rejected = assert.rejects(controller.waitForStart("waiting", signal));
    cancel(controller);
    await rejected;
    assert.equal(controller.awaitingStartTrialId, undefined);
    assert.equal(controller.startPreparedTrial("waiting"), false);
  }
});

test("returning to the menu cancels the trial and queued work but keeps the session alive", async () => {
  const controller = new SessionController();
  controller.selectCategory("combat");
  controller.selectScenario("queued");
  const active = controller.beginTrial("active");
  controller.returnToMenu();
  await controller.waitUntilRunnable();
  assert.equal(active.reason, "menu");
  assert.equal(controller.signal.aborted, false);
  assert.equal(controller.continuousEnabled, false);
  assert.equal(controller.takeRequestedScenario(), undefined);
  assert.equal(controller.takeScheduleChange(), false);
  assert.equal(controller.takeMenuRequest(), true);
  assert.equal(controller.takeMenuRequest(), false);
  controller.selectScenario("next");
  await controller.waitUntilRunnable();
  assert.equal(controller.takeRequestedScenario(), "next");
});

test("skip and selection cancel active trials", () => {
  const controller = new SessionController();
  const skipped = controller.beginTrial("trial-1");
  controller.skip();
  assert.equal(skipped.aborted, true);
  assert.equal(skipped.reason, "skip");
  controller.finishTrial("trial-1", skipped);

  const selected = controller.beginTrial("trial-2");
  controller.selectScenario("oak-tree");
  assert.equal(selected.aborted, true);
  assert.equal(selected.reason, "select");
  assert.equal(controller.takeRequestedScenario(), "oak-tree");
  assert.equal(controller.takeRequestedScenario(), undefined);
});

test("stopping cancels both the active trial and run lifetime", () => {
  const controller = new SessionController();
  const trial = controller.beginTrial("trial-1");
  controller.stop();

  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason, "stop");
  assert.equal(trial.aborted, true);
  assert.equal(trial.reason, "stop");
});

test("repeat preference stays idle until a scenario is selected, even after another scheduler wake", async () => {
  const controller = new SessionController();
  controller.setContinuous(false);
  let resumed = false;
  const waiting = controller.waitUntilRunnable().then(() => { resumed = true; });
  controller.setContinuous(true);
  controller.setJobs(2); // A wake from another control must still respect the idle state.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.continuousEnabled, true);
  assert.equal(controller.canRepeat, false);
  assert.equal(resumed, false);
  controller.selectScenario("chosen");
  await waiting;
  assert.equal(controller.canRepeat, true);
});

test("repeat can be enabled during an active trial, but cannot restart a completed paused run", () => {
  const controller = new SessionController();
  controller.setContinuous(false);
  controller.selectScenario("chosen");
  controller.takeRequestedScenario();
  const active = controller.beginTrial("active");
  controller.setContinuous(true);
  assert.equal(active.aborted, false);
  controller.finishTrial("active", active);
  assert.equal(controller.canRepeat, true);

  const last = controller.beginTrial("last");
  controller.setContinuous(false);
  controller.finishTrial("last", last);
  controller.setContinuous(true);
  assert.equal(controller.canRepeat, false);
});

test("selection allows one trial while repetition is paused", async () => {
  const controller = new SessionController();
  controller.setContinuous(false);

  const waiting = controller.waitUntilRunnable();
  controller.selectScenario("sand-bank");
  await waiting;

  assert.equal(controller.continuousEnabled, false);
  assert.equal(controller.takeRequestedScenario(), "sand-bank");
});

test("single-scenario mode can be toggled without interrupting the active trial", () => {
  const controller = new SessionController();
  const trial = controller.beginTrial("trial-1");

  controller.setSingleScenario(true);
  assert.equal(controller.singleScenarioEnabled, true);
  assert.equal(trial.aborted, false);

  controller.setSingleScenario(false);
  assert.equal(controller.singleScenarioEnabled, false);
  assert.equal(trial.aborted, false);
});

test("selecting a category changes the schedule and interrupts the active trial", () => {
  const controller = new SessionController();
  controller.selectScenario("old-selection");
  const trial = controller.beginTrial("trial-1");

  controller.selectCategory("sleep");

  assert.equal(trial.aborted, true);
  assert.equal(trial.reason, "select");
  assert.equal(controller.selectedCategory, "sleep");
  assert.equal(controller.takeRequestedScenario(), undefined);
  assert.equal(controller.takeScheduleChange(), true);
  assert.equal(controller.takeScheduleChange(), false);

  controller.selectCategory(undefined);
  assert.equal(controller.selectedCategory, undefined);
  assert.equal(controller.takeScheduleChange(), true);
});

test("parallel trial controls cancel every occupied worker", () => {
  const controller = new SessionController();
  const first = controller.beginTrial("trial-1");
  const second = controller.beginTrial("trial-2");

  controller.skip();

  assert.equal(first.aborted, true);
  assert.equal(first.reason, "skip");
  assert.equal(second.aborted, true);
  assert.equal(second.reason, "skip");
  controller.finishTrial("trial-1", first);
  controller.finishTrial("trial-2", second);
});

test("parallel trial identities must be unique while active", () => {
  const controller = new SessionController();
  const first = controller.beginTrial("trial-1");
  assert.throws(() => controller.beginTrial("trial-1"), /already owns trial/);
  controller.finishTrial("trial-1", first);
  assert.doesNotThrow(() => controller.beginTrial("trial-1"));
});
