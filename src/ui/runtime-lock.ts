import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { errorCode } from "../util/fs.js";

/** Do not let two launchers rewrite one development client while it is running. */
export async function lockClientRuntime(runtime: string): Promise<() => Promise<void>> {
  const path = join(runtime, "session.lock");
  try {
    const pid = Number(await readFile(path, "utf8"));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); }
      catch (error) {
        if (errorCode(error) === "ESRCH") await rm(path);
        else throw error;
      }
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const lock = await open(path, "wx").catch((error: unknown) => {
    throw new Error(`cannot own Mine Labs client at ${runtime}; another session may be using it: ${String(error)}`);
  });
  try { await lock.writeFile(String(process.pid)); }
  catch (error) { await lock.close(); await rm(path); throw error; }
  return async () => { await lock.close(); await rm(path, { force: true }); };
}
