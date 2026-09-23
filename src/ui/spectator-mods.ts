import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Scenario } from "../scenario/schema.js";

export interface SpectatorSetup {
  mods: { id: string; path: string; sha256: string }[];
  systemProperties: Record<string, string>;
}

/** A running Java client has one mod set, shared by the entire selected catalog. */
export async function collectSpectatorSetup(scenarios: readonly Scenario[]): Promise<SpectatorSetup> {
  const mods = new Map<string, SpectatorSetup["mods"][number]>();
  const hashes = new Map<string, string>();
  const systemProperties: Record<string, string> = {};
  for (const scenario of scenarios) {
    for (const mod of scenario.spectator?.mods ?? []) {
      let sha256 = hashes.get(mod.path);
      if (sha256 === undefined) {
        const contents = await readFile(mod.path).catch((cause: unknown) => {
          throw new Error(`Cannot read spectator mod '${mod.id}' at '${mod.path}': ${String(cause)}`);
        });
        sha256 = createHash("sha256").update(contents).digest("hex");
        hashes.set(mod.path, sha256);
      }
      const previous = mods.get(mod.id);
      if (previous && previous.sha256 !== sha256) {
        throw new Error(`Conflicting spectator mod '${mod.id}': '${previous.path}' and '${mod.path}'. Use one version for the catalog.`);
      }
      mods.set(mod.id, { ...mod, sha256 });
    }
    for (const [key, value] of Object.entries(scenario.spectator?.systemProperties ?? {})) {
      if (key.startsWith("minelabs.")) throw new Error(`Spectator system property '${key}' is reserved by Mine Labs.`);
      if (Object.hasOwn(systemProperties, key) && systemProperties[key] !== value) {
        throw new Error(`Conflicting spectator system property '${key}'. Use one value for the catalog.`);
      }
      Object.defineProperty(systemProperties, key, { value, enumerable: true, configurable: true });
    }
  }
  return { mods: [...mods.values()].sort((a, b) => a.id.localeCompare(b.id)), systemProperties };
}

/** Paths may differ while the installed bytes and properties are unchanged. */
export function spectatorSetupKey(setup: SpectatorSetup): string {
  return JSON.stringify({
    mods: setup.mods.map(({ id, sha256 }) => ({ id, sha256 })),
    properties: Object.entries(setup.systemProperties).sort(([a], [b]) => a.localeCompare(b)),
  });
}

/** Reconcile only Mine Labs-owned JARs; manually installed mods stay untouched. */
export async function installSpectatorMods(directory: string, setup: SpectatorSetup): Promise<void> {
  await mkdir(directory, { recursive: true });
  const wanted = new Set(setup.mods.map((mod) => `mine-labs-spectator-${mod.id}.jar`));
  for (const name of await readdir(directory)) {
    if (/^mine-labs-spectator-[a-z][a-z0-9_-]*\.jar$/u.test(name) && !wanted.has(name)) {
      await unlink(join(directory, name));
    }
  }
  for (const mod of setup.mods) {
    await copyFile(mod.path, join(directory, `mine-labs-spectator-${mod.id}.jar`));
  }
}
