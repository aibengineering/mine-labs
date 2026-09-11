/**
 * Filesystem and timing primitives shared across the harness.
 *
 * Mine Labs writes into directories that may not exist yet (run roots, world
 * folders, generated datapacks), and it repeatedly has to decide whether a
 * filesystem error is "the thing is simply not there" or a real fault worth
 * failing a run over. `errorCode` exists so that check is written the same way
 * everywhere instead of re-deriving the `instanceof Error && "code" in error`
 * dance at each call site.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Write a file, creating its parent directories first. */
export async function writeTextFile(p: string, content: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content, "utf8");
}

/** Root for mine-labs caches: server jars live under <root>/servers. */
export function mineLabsHome(): string {
  return process.env.MINE_LABS_HOME ?? join(homedir(), ".mine-labs");
}

/** The `errno` code of a filesystem error, for distinguishing ENOENT/EEXIST from real faults. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
