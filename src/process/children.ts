/**
 * Make sure no process Mine Labs started outlives Mine Labs.
 *
 * A run owns Minecraft servers and client processes, and an orphaned Minecraft
 * server is genuinely disruptive: it holds ports and world files, so it breaks
 * later runs rather than the one that leaked it. Crashes and Ctrl-C are exactly
 * when cleanup is skipped, so this registry hooks process exit and uncaught
 * exceptions to reap children synchronously as a last resort.
 *
 * Two details are deliberate. The hooks are installed only while children are
 * actually live, so importing Mine Labs as a library never permanently changes
 * its host process. And on Windows termination goes through `taskkill /T`,
 * because killing the Java launcher there does not kill the JVM beneath it.
 */

import { spawnSync } from "node:child_process";

export interface ManagedChild {
  readonly pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

const managedChildren = new Map<ManagedChild, () => void>();
let exitHooksInstalled = false;

/**
 * Register a process launched by Mine Labs until all of its stdio handles close.
 * The registry exists only while children are live, so importing the library
 * does not permanently modify its host process.
 */
export function registerManagedChild(child: ManagedChild): void {
  if (managedChildren.has(child)) return;
  const unregister = (): void => {
    managedChildren.delete(child);
    if (managedChildren.size === 0) removeExitHooks();
  };
  managedChildren.set(child, unregister);
  child.once("close", unregister);
  installExitHooks();
}

/** Last-ditch synchronous cleanup for process exit and uncaught exceptions. */
export function reapManagedChildren(): void {
  const children = [...managedChildren.entries()];
  managedChildren.clear();
  removeExitHooks();
  for (const [child, unregister] of children) {
    child.off("close", unregister);
    if (child.exitCode !== null || child.signalCode !== null) continue;
    terminateProcessTree(child);
  }
}

/** @internal Test visibility for the process-lifetime invariant. */
export function managedChildCount(): number {
  return managedChildren.size;
}

/** Wait for a process to close without allowing it to wedge its owner forever. */
export function waitForChildExit(child: ManagedChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onClose = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("close", onClose);
      resolve(false);
    }, timeoutMs);
    child.once("close", onClose);
  });
}

/** Race an asynchronous cleanup against a deadline without leaving a timer behind. */
export function settledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([promise.then(() => true), expired]).finally(() => clearTimeout(timer));
}

function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  process.once("exit", reapManagedChildren);
  process.once("uncaughtExceptionMonitor", reapManagedChildren);
}

function removeExitHooks(): void {
  if (!exitHooksInstalled) return;
  exitHooksInstalled = false;
  process.off("exit", reapManagedChildren);
  process.off("uncaughtExceptionMonitor", reapManagedChildren);
}

export function terminateProcessTree(child: ManagedChild): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (result.status === 0) return;
    } catch {
      // Fall through to Node's direct-child termination below.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Process exit is already in progress; there is nowhere useful to surface
    // a last-ditch cleanup error.
  }
}
