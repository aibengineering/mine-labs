import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { loadScenario, ScenarioError } from "./loader.js";
import type { Scenario } from "./schema.js";
import { expandVerificationLocations } from "../session/verification.js";
import type { SessionScenario } from "../session/run.js";

interface CatalogScenario {
  file: string;
  id: string;
  category: string;
  scenario: Scenario;
}

/** Load each source file once; verification manifests remain unexpanded here. */
export async function loadScenarioCatalog(inputs: string[]): Promise<{ scenarios: CatalogScenario[]; initial?: string }> {
  if (!inputs.length) throw new ScenarioError("no scenario paths supplied");
  const scenarios: CatalogScenario[] = [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  let initial: string | undefined;
  for (const [index, input] of inputs.entries()) {
    const path = resolve(input);
    const info = await stat(path).catch((error: unknown) => {
      throw new ScenarioError(`cannot read scenario path '${input}': ${String(error)}`);
    });
    const directory = info.isDirectory();
    if (!directory && (!info.isFile() || !/\.(ya?ml|json)$/iu.test(path))) {
      throw new ScenarioError(`scenario path '${input}' must be a directory or a YAML/JSON file`);
    }
    const files = directory ? await discoverScenarioFiles(path) : [path];
    if (!files.length) throw new ScenarioError(`no scenario files found in ${path}`);
    const root = directory ? path : dirname(path);
    for (const file of files) {
      const key = process.platform === "win32" ? file.toLowerCase() : file;
      if (seen.has(key)) continue;
      seen.add(key);
      const localId = relative(root, file).replaceAll("\\", "/").slice(0, -extname(file).length);
      const id = inputs.length > 1 ? `${index + 1}/${localId}` : localId;
      if (ids.has(id)) throw new ScenarioError(`duplicate scenario id '${id}': use distinct filenames for '${file}'`);
      ids.add(id);
      const folder = basename(dirname(file));
      scenarios.push({ file, id, category: folder.toLowerCase() === "scenarios" ? "other" : folder,
        scenario: await loadScenario(file) });
      if (inputs.length === 1 && !directory) initial = id;
    }
  }
  return { scenarios, initial };
}

/** The dashboard, list, and headless run use the same selectable trial identities. */
export async function loadRunCatalog(inputs: string[], username?: string): Promise<{ scenarios: SessionScenario[]; initial?: string }> {
  const catalog = await loadScenarioCatalog(inputs);
  const scenarios: SessionScenario[] = [];
  const ids = new Set<string>();
  for (const { file, id, category, scenario } of catalog.scenarios) {
    if (username && scenario.minecraft.version !== "1.21.4") {
      throw new ScenarioError(`${file}: the bundled Mine Labs client supports Minecraft 1.21.4; found ${scenario.minecraft.version}`);
    }
    if (username && scenario.players.some((player) => player.name.toLowerCase() === username.toLowerCase())) {
      throw new ScenarioError(`${file}: player '${username}' is reserved for the Mine Labs spectator`);
    }
    const attempts = scenario.verification ? expandVerificationLocations([scenario]) : [scenario];
    for (const [index, attempt] of attempts.entries()) {
      const attemptId = scenario.verification ? `${id}@${index + 1}` : id;
      if (ids.has(attemptId)) throw new ScenarioError(`duplicate scenario id '${attemptId}' after location expansion: rename '${file}'`);
      ids.add(attemptId);
      scenarios.push({ id: attemptId, scenario: attempt, category });
    }
  }
  return { scenarios, initial: catalog.initial ? scenarios[0]!.id : undefined };
}

/** Folder scans include YAML only, so generated JSON evidence is never mistaken for a test. */
async function discoverScenarioFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discoverScenarioFiles(path));
    else if (entry.isFile() && /\.ya?ml$/iu.test(entry.name)) files.push(path);
  }
  return files;
}
