/**
 * Decide which humans may join a scenario world as operators.
 *
 * Every Mine Labs server is offline-mode and freshly created, so it has no
 * accounts and no permissions of its own. Someone who wants to watch a trial
 * still needs to be able to get in and fly around. Rather than putting human
 * identities into scenario files - where they would be committed, shared, and
 * wrong on every other machine - this reads the operator list from Mine Labs'
 * machine-local config, so the same suite grants the right people access on
 * each person's own machine without the suite mentioning anyone.
 *
 * Offline-mode UUIDs are derived exactly the way Java does it (an MD5 of
 * `OfflinePlayer:<name>`), because `ops.json` is keyed by UUID and a wrong one
 * silently grants nothing.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface OperatorProfile {
  uuid: string;
  name: string;
  level: 2;
  bypassesPlayerLimit: true;
}

interface MineLabsConfig {
  schemaVersion?: unknown;
  operators?: unknown;
}

interface OperatorPolicyOptions {
  configFile?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** Resolve Mine Labs' machine-local policy file without putting identities in scenario files. */
function mineLabsConfigFile(options: OperatorPolicyOptions = {}): string {
  const env = options.env ?? process.env;
  if (options.configFile ?? env.MINE_LABS_CONFIG) return resolve(options.configFile ?? String(env.MINE_LABS_CONFIG));
  const home = resolve(options.home ?? homedir());
  const configHome = env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : join(home, ".config");
  return join(configHome, "minelabs", "config.json");
}

/**
 * Mine Labs creates an offline-mode server for every run. Use its machine-local
 * operator list so named humans can join every fixture with
 * the same permission level, while scenario clients remain scenario-owned.
 */
export function defaultOperatorProfiles(options: OperatorPolicyOptions = {}): OperatorProfile[] {
  const file = mineLabsConfigFile(options);

  let config: MineLabsConfig;
  try {
    const text = readFileSync(file, "utf8");
    config = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as MineLabsConfig;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw new Error(`Could not read Mine Labs operator config ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!config || typeof config !== "object" || config.schemaVersion !== 1) {
    throw new Error(`Mine Labs operator config ${file} must be a schemaVersion 1 JSON object.`);
  }

  const names = new Map<string, string>();
  const configured = config.operators ?? [];
  if (!Array.isArray(configured)) {
    throw new Error(`Mine Labs operator config ${file} operators must be an array.`);
  }
  for (const [index, entry] of configured.entries()) {
    if (typeof entry !== "string" || !/^[A-Za-z0-9_]{1,16}$/u.test(entry.trim())) {
      throw new Error(`Mine Labs operator config ${file} operators[${index}] must be a Java username.`);
    }
    const name = entry.trim();
    names.set(name.toLowerCase(), name);
  }
  return [...names.values()].map((name) => ({
    uuid: offlinePlayerUuid(name),
    name,
    level: 2,
    bypassesPlayerLimit: true,
  }));
}

/** Java's offline-mode UUID for `OfflinePlayer:<username>`. */
export function offlinePlayerUuid(name: string): string {
  const bytes = createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x30;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
