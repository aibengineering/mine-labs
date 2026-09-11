/**
 * Turn a finished trial into evidence worth keeping, and throw away the rest.
 *
 * Compaction removes disposable world files while retaining results, scenario
 * snapshots, client/server logs, tick samples, and client-owned artifacts.
 * Retention bounds completed run directories without deleting active trials.
 */

import { existsSync } from "node:fs";
import { copyFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunResult } from "../trial/run.js";
import { errorCode } from "../util/fs.js";

export async function writeRunResult(runDir: string, result: RunResult): Promise<void> {
  await writeFile(join(runDir, "results.json"), JSON.stringify(result, null, 2));
}

/**
 * Reduce a finished isolated run to the evidence worth keeping: the result
 * and the server log it was produced from. Writing evidence and
 * pruning it are the same concern, so they live together.
 *
 * Pruning deletes everything else in the directory, so it must only ever see
 * a directory this run created. An evidence root - anything holding a `runs/`
 * directory - is refused outright: pointing a run at one once deleted several
 * days of collected results.
 */
export async function compactIsolatedRun(runDir: string): Promise<void> {
  if (existsSync(join(runDir, "runs"))) {
    throw new Error(`Refusing to prune ${runDir}: it holds a runs/ directory, so it is an evidence root, not a run directory.`);
  }
  await copyFile(join(runDir, "logs", "latest.log"), join(runDir, "server.log")).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") throw error;
  });
  const retained = new Set(["results.json", "server.log", "scenario.json", "client.log", "tick-query.txt", "artifacts"]);
  for (const entry of await readdir(runDir, { withFileTypes: true })) {
    if (!retained.has(entry.name)) await rm(join(runDir, entry.name), { recursive: true, force: true });
  }
}

/** Keep only the newest completed run directories, oldest discarded first. */
export async function retainNewestRuns(
  runsDir: string,
  keepRuns: number,
  activeRunDirectories: ReadonlySet<string> = new Set(),
): Promise<void> {
  const directories = (await readdir(runsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !activeRunDirectories.has(join(runsDir, entry.name)))
    .sort((left, right) => left.name.localeCompare(right.name));
  const discard = keepRuns === 0 ? directories : directories.slice(0, Math.max(0, directories.length - keepRuns));
  for (const entry of discard) await rm(join(runsDir, entry.name), { recursive: true, force: true });
}
