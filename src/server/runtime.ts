/**
 * Share one cached copy of the Minecraft runtime between every run directory.
 *
 * A Minecraft server unpacks several hundred megabytes of libraries and version
 * data next to itself. With a fresh run directory per trial - which is what
 * makes isolated trials isolated - that would be re-downloaded and re-written
 * every single time, and a long session would fill the disk.
 *
 * So the heavy, immutable directories live once in the user's cache and each
 * run root gets a symlink (a junction on Windows) pointing at them. Only the
 * genuinely per-run state - the world, the logs, the config - is real data
 * inside a run directory, which is also what makes those directories cheap to
 * delete afterwards.
 */

import { lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { errorCode, mineLabsHome } from "../util/fs.js";

const SHARED_DIRECTORIES = ["libraries", "versions"];

/** Link one run root to the versioned server runtime cache owned by mine-labs. */
export async function linkServerRuntime(runRoot: string, version: string): Promise<void> {
  const cacheHome = process.env.MINE_LABS_RUNTIME_HOME ?? mineLabsHome();
  const cacheRoot = join(cacheHome, "runtimes", version);
  await mkdir(runRoot, { recursive: true });
  await mkdir(cacheRoot, { recursive: true });

  for (const name of SHARED_DIRECTORIES) {
    const sharedDirectory = resolve(cacheRoot, name);
    const runLink = resolve(runRoot, name);
    await mkdir(sharedDirectory, { recursive: true });
    await ensureLink(runLink, sharedDirectory);
  }
}

/** Keep a reusable run root pointed at the current user's runtime cache. */
async function ensureLink(runLink: string, sharedDirectory: string): Promise<void> {
  const type = process.platform === "win32" ? "junction" : "dir";
  try {
    await symlink(sharedDirectory, runLink, type);
    return;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }

  const existing = await lstat(runLink);
  if (!existing.isSymbolicLink()) {
    throw new Error(`Refusing to replace the real directory at ${runLink}`);
  }

  const target = resolve(dirname(runLink), await readlink(runLink));
  if (samePath(target, sharedDirectory)) return;

  await unlink(runLink);
  await symlink(sharedDirectory, runLink, type);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
