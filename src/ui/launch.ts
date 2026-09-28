/**
 * Launch the package's own NeoForge client, or build its mod for a client Mine
 * Labs does not launch, with writable build/game files outside node_modules.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerManagedChild, terminateProcessTree, waitForChildExit } from "../process/children.js";
import { errorCode } from "../util/fs.js";
import { findModJar } from "./build.js";
import { lockClientRuntime } from "./runtime-lock.js";
import { installSpectatorMods, type SpectatorSetup } from "./spectator-mods.js";

export const SPECTATOR_USERNAME = "LabSpectator";

/** Copy the package's client sources into the writable runtime; the caller holds its lock. */
async function refreshClientSources(runtime: string): Promise<void> {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "../../client-mod");
  // These package-owned source folders are replaced so removed Java files cannot survive an upgrade.
  for (const folder of ["src", "gradle"]) {
    const target = join(runtime, folder);
    await rm(target, { recursive: true, force: true });
    await cp(join(source, folder), target, { recursive: true });
  }
  for (const file of ["build.gradle", "settings.gradle", "gradle.properties"]) {
    await cp(join(source, file), join(runtime, file));
  }
}

/**
 * Run a Gradle task in the writable client runtime, with all output in `logPath`.
 *
 * The child keeps its own copy of the log descriptor, so ours is closed as soon
 * as it has started. Registering the child lets an interrupted harness reap it.
 */
async function spawnGradle(runtime: string, task: string, logPath: string, env?: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const logFile = await open(logPath, "w");
  try {
    const child = spawn(javaCommand(), ["-jar", join(runtime, "gradle/wrapper/gradle-wrapper.jar"), task, "--no-daemon", "--console=plain"], {
      cwd: runtime, windowsHide: true, shell: false, stdio: ["ignore", logFile.fd, logFile.fd], env,
    });
    registerManagedChild(child);
    return child;
  } finally {
    await logFile.close();
  }
}

function javaCommand(): string {
  const javaName = process.platform === "win32" ? "javaw.exe" : "java";
  return process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", javaName) : javaName;
}

/**
 * Build the installable Mine Labs mod JAR for a client Mine Labs does not launch.
 *
 * Tailscale remote mode serves it to a player's own launcher. It builds in the
 * same writable runtime as the managed client, never inside node_modules.
 */
export async function buildRemoteClientMod(options: { rootDir: string; log: (message: string) => void }): Promise<string> {
  const runtime = resolve(options.rootDir, "client");
  await mkdir(runtime, { recursive: true });
  const unlock = await lockClientRuntime(runtime);
  try {
    await refreshClientSources(runtime);
    const libs = join(runtime, "build", "libs");
    await rm(libs, { recursive: true, force: true });
    const logPath = join(runtime, "build-mod.log");
    options.log(`building the Mine Labs mod for remote clients; first build downloads NeoForge (log: ${logPath})`);
    const child = await spawnGradle(runtime, "jar", logPath);
    await new Promise<void>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => code === 0 ? resolvePromise()
        : reject(new Error(`Mine Labs mod build exited ${code ?? signal}; see ${logPath}`)));
    });
    const jar = await findModJar(libs);
    if (!jar) throw new Error(`Mine Labs mod build produced no mine-labs-ui-*.jar; see ${logPath}`);
    return jar;
  } finally {
    await unlock();
  }
}

export async function launchSpectatorClient(options: {
  rootDir: string; uiPort: number; log: (message: string) => void;
  setup: SpectatorSetup;
}): Promise<{ closed: Promise<void>; stop: () => Promise<void> }> {
  const runtime = resolve(options.rootDir, "client");
  await mkdir(runtime, { recursive: true });
  // One invocation owns this build directory and game instance until its child closes.
  const unlock = await lockClientRuntime(runtime);
  try {
    await refreshClientSources(runtime);
    await mkdir(join(runtime, "run"), { recursive: true });
    await installSpectatorMods(join(runtime, "run", "mods"), options.setup);
    await writeFile(join(runtime, "spectator-properties.json"), JSON.stringify(options.setup.systemProperties));
    // Written once only: an operator's own settings in an existing options.txt win.
    await writeFile(join(runtime, "run", "options.txt"), "onboardAccessibility:false\nguiScale:2\ntutorialStep:none\n", { flag: "wx" })
      .catch((error: unknown) => { if (errorCode(error) !== "EEXIST") throw error; });
    const logPath = join(runtime, "launcher.log");
    options.log(`opening Mine Labs Minecraft client; first launch downloads NeoForge (log: ${logPath})`);
    const child = await spawnGradle(runtime, "runClient", logPath,
      { ...process.env, MINE_LABS_UI_URL: `http://127.0.0.1:${options.uiPort}`, MINE_LABS_USERNAME: SPECTATOR_USERNAME });
    // Set by `stop`, so the exit it causes is not reported as a client failure.
    let stopping = false;
    const processClosed = new Promise<void>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0 || stopping) resolvePromise();
        else reject(new Error(`Mine Labs client exited ${code ?? signal}; see ${logPath}`));
      });
    });
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
