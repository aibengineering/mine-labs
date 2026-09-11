import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  managedChildCount,
  reapManagedChildren,
  registerManagedChild,
  waitForChildExit,
  type ManagedChild,
} from "./children.js";

test("managed children are reaped synchronously when the harness exits", () => {
  const child = new FakeChild();
  registerManagedChild(child);

  assert.equal(managedChildCount(), 1);
  reapManagedChildren();

  assert.deepEqual(child.signals, ["SIGKILL"]);
  assert.equal(managedChildCount(), 0);
});

test("a managed child unregisters when its process closes", () => {
  const child = new FakeChild();
  registerManagedChild(child);
  child.exitCode = 0;
  child.emit("close");

  assert.equal(managedChildCount(), 0);
});

test("waiting for a child exit is bounded", async () => {
  const child = new FakeChild();
  assert.equal(await waitForChildExit(child, 5), false);
  child.exitCode = 0;
  assert.equal(await waitForChildExit(child, 5), true);
});

class FakeChild extends EventEmitter implements ManagedChild {
  pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    return true;
  }
}
