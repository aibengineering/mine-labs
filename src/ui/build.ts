/** Build the client mod from a source checkout for development or manual installation. */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ClientModBuild {
  modRoot: string;
  jar: string;
}

export async function buildClientMod(log: (message: string) => void = console.log): Promise<ClientModBuild> {
  const modRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../client-mod");
  const java = process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
    : "java";
  log(`building Mine Labs client mod in ${modRoot}`);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(java, ["-jar", join(modRoot, "gradle/wrapper/gradle-wrapper.jar"), "build", "--no-daemon"], {
      cwd: modRoot, stdio: "inherit", windowsHide: true, shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`client mod build exited ${code ?? signal ?? "unknown"}`));
    });
  });
  const libs = join(modRoot, "build", "libs");
  const jars = (await readdir(libs))
    .filter(name => name.startsWith("mine-labs-ui-") && name.endsWith(".jar") && !name.includes("sources"))
    .sort();
  const jar = jars.at(-1);
  if (!jar) throw new Error("client mod build produced no mine-labs-ui-*.jar");
  return { modRoot, jar: join(libs, jar) };
}
