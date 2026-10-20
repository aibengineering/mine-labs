import { constants, getPriority, setPriority } from "node:os";

const BELOW_NORMAL = constants.priority.PRIORITY_BELOW_NORMAL;

/**
 * Lets the machine's foreground work come first. A session's Minecraft servers
 * and bot clients can keep every core busy, usually on a machine someone is
 * using at the same time. Lowering this process before anything starts lowers
 * every server and client it launches as well, because they inherit it: the
 * below-normal priority class on Windows, niceness elsewhere. Trials then get
 * whatever the foreground leaves rather than competing with it.
 *
 * A process already running lower keeps its priority. A platform that refuses
 * leaves the session at normal priority, which only costs the foreground.
 */
export function yieldToForeground(): void {
  try {
    // Higher numbers are lower priorities.
    if (getPriority() < BELOW_NORMAL) setPriority(BELOW_NORMAL);
  } catch {
    // Not fatal: the trials still run, at the priority they started with.
  }
}
