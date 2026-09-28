/**
 * Find the Java a Minecraft server will run under, and say plainly when it is
 * too old.
 *
 * Each Minecraft release is compiled for one minimum Java (1.21.4 needs 21),
 * and a machine commonly has an older one first on PATH. The JVM's own
 * complaint is an `UnsupportedClassVersionError` naming class file versions,
 * which does not say which Java to install or how to point Mine Labs at it.
 * The server's requirement comes from that error rather than a table here, so
 * any Minecraft version gets an accurate message; `doctor` checks against the
 * bundled client's version ahead of time.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** The Java Minecraft 1.21.4, the version the bundled client targets, needs. */
export const REQUIRED_JAVA_MAJOR = 21;

/** Class file major versions are the Java feature release plus 44 (Java 21 writes 65). */
const CLASS_FILE_OFFSET = 44;

/** The `java` the server is launched with: `$JAVA_HOME/bin/java` when set, otherwise PATH. */
export function javaExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const name = process.platform === "win32" ? "javaw.exe" : "java";
  return env.JAVA_HOME ? join(env.JAVA_HOME, "bin", name) : name;
}

/** Read `java -version`; undefined when that Java cannot be run or its answer is not recognised. */
export function readJavaVersion(java = javaExecutable()): { version: string; major: number } | undefined {
  // `javaw` has no console, so ask its sibling `java` in the same directory.
  const probe = java.replace(/javaw\.exe$/u, "java.exe");
  const result = spawnSync(probe, ["-version"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? parseJavaVersion(`${result.stderr}${result.stdout}`) : undefined;
}

/** Parse `java -version` output; both `"21.0.2"` and the pre-9 `"1.8.0_392"` spellings. */
export function parseJavaVersion(output: string): { version: string; major: number } | undefined {
  const version = /version "([^"]+)"/u.exec(output)?.[1];
  if (!version) return undefined;
  const [first, second] = version.split(/[.+_-]/u).map(Number);
  const major = first === 1 ? second : first;
  return major === undefined || !Number.isInteger(major) ? undefined : { version, major };
}

/**
 * Turn the JVM's class-version refusal into what to do about it, or undefined
 * when `output` is not that refusal.
 */
export function javaTooOldMessage(output: string, java: string, minecraftVersion: string): string | undefined {
  const match = /class file version (\d+)(?:\.\d+)?.*?up to (\d+)/su.exec(output);
  if (!match) return undefined;
  const required = Number(match[1]) - CLASS_FILE_OFFSET;
  const found = Number(match[2]) - CLASS_FILE_OFFSET;
  return `Minecraft ${minecraftVersion} needs Java ${required} or newer, but ${java} is Java ${found}. `
    + `Install Java ${required} and set JAVA_HOME to it (Mine Labs runs $JAVA_HOME/bin/java), `
    + "or put it first on PATH; `mine-labs doctor` shows the Java that will be used.";
}
