/** Launch the package's own NeoForge client, with writable build/game files outside node_modules. */
import { spawn } from "node:child_process";
import { cp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerManagedChild, terminateProcessTree, waitForChildExit } from "../process/children.js";
import { lockClientRuntime } from "./runtime-lock.js";

export const SPECTATOR_USERNAME = "LabSpectator";

export async function launchSpectatorClient(options: {
  rootDir: string; uiPort: number; log: (message: string) => void;
}): Promise<{ closed: Promise<void>; stop: () => Promise<void> }> {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "../../client-mod");
  const runtime = resolve(options.rootDir, "client");
  await mkdir(runtime, { recursive: true });
  // One invocation owns this build directory and game instance until its child closes.
  const unlock = await lockClientRuntime(runtime);
  try {
    // These package-owned source folders are replaced so removed Java files cannot survive an upgrade.
    for (const folder of ["src", "gradle"]) {
      const target = join(runtime, folder);
      await rm(target, { recursive: true, force: true });
      await cp(join(source, folder), target, { recursive: true });
    }
    for (const file of ["build.gradle", "settings.gradle", "gradle.properties"]) {
      await cp(join(source, file), join(runtime, file));
    }
    await mkdir(join(runtime, "run"), { recursive: true });
    await writeFile(join(runtime, "run", "options.txt"), "onboardAccessibility:false\nguiScale:2\ntutorialStep:none\n", { flag: "wx" })
      .catch((error: unknown) => { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; });
    const logFile = await open(join(runtime, "launcher.log"), "w");
    const javaName = process.platform === "win32" ? "javaw.exe" : "java";
    const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", javaName) : javaName;
    options.log(`opening Mine Labs Minecraft client; first launch downloads NeoForge (log: ${join(runtime, "launcher.log")})`);
    let child;
    try {
      child = spawn(java, ["-jar", join(runtime, "gradle/wrapper/gradle-wrapper.jar"), "runClient", "--no-daemon", "--console=plain"], {
        cwd: runtime, windowsHide: true, shell: false,
        stdio: ["ignore", logFile.fd, logFile.fd],
        env: { ...process.env, MINE_LABS_UI_URL: `http://127.0.0.1:${options.uiPort}`, MINE_LABS_USERNAME: SPECTATOR_USERNAME },
      });
      registerManagedChild(child);
    } finally {
      await logFile.close();
    }
    const processClosed = new Promise<void>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0 || stopping) resolvePromise();
        else reject(new Error(`Mine Labs client exited ${code ?? signal}; see ${join(runtime, "launcher.log")}`));
      });
    });
    let stopping = false;
    const closed = processClosed.finally(unlock);
    // The caller may still be setting up its session when the launcher fails.
    void closed.catch(() => undefined);
    return {
      closed,
      stop: async () => {
        stopping = true;
        if (child.exitCode === null && child.signalCode === null) terminateProcessTree(child);
        if (!await waitForChildExit(child, 5000)) throw new Error("Mine Labs client did not stop within five seconds");
        await closed.catch(() => undefined);
      },
    };
  } catch (error) {
    await unlock();
    throw error;
  }
}
