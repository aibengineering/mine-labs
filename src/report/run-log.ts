import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

/** Keep per-trial diagnostics through failure and world compaction. */
export async function withRunLog<T>(
  runDir: string,
  emit: (message: string) => void,
  run: (log: (message: string) => void) => Promise<T>,
): Promise<T> {
  await mkdir(runDir, { recursive: true });
  await using file = await open(join(runDir, "client.log"), "a");
  let tail = Promise.resolve();
  const log = (message: string): void => {
    emit(message);
    const line = `${new Date().toISOString()} ${message}\n`;
    tail = tail.then(async () => { await file.write(line); });
    // Report a write failure when draining, rather than as an unhandled
    // rejection while the client is still running.
    void tail.catch(() => undefined);
  };
  try {
    return await run(log);
  } finally {
    await tail;
  }
}
