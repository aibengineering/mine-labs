import assert from "node:assert/strict";
import test from "node:test";
import { SessionController } from "./controller.js";

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

test("repeat mode pauses and resumes between trials", async () => {
  const controller = new SessionController();
  controller.setContinuous(false);
  assert.equal(controller.continuousEnabled, false);

  let resumed = false;
  const waiting = controller.waitUntilRunnable().then(() => {
    resumed = true;
  });
  await Promise.resolve();
  assert.equal(resumed, false);

  controller.setContinuous(true);
  await waiting;
  assert.equal(controller.continuousEnabled, true);
  assert.equal(resumed, true);
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
