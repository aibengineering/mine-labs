/**
 * Read a scenario file off disk and turn it into a validated `Scenario`.
 *
 * The work that is not obvious from the name is all about error quality and
 * path resolution. Every failure - unreadable file, malformed YAML, schema
 * violation - is reported as a `ScenarioError` naming the file, the field path,
 * and, when a template was involved, which scenario or template pulled it in.
 * A scenario author should never have to guess which of two files a message is
 * about.
 *
 * Templates let a suite share defaults: the template supplies fields it names,
 * the scenario overrides them (a template may build on another the same way),
 * and schema defaults apply only once the merged
 * result is complete - which is why the template is validated as fully-optional
 * and the merge is validated again as a whole.
 *
 * Relative paths in `client.cwd` resolve against the scenario file, not the
 * process's working directory, so a suite behaves the same wherever it is run
 * from.
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { parse as yamlParse } from "yaml";
import type { z } from "zod";
import {
  scenarioFileSchema,
  scenarioSchema,
  type Scenario,
  type ScenarioTemplate,
} from "./schema.js";

export class ScenarioError extends Error {}

/**
 * How many templates one scenario may stack. A chain is a readability cost
 * paid by every author who has to find where a field came from, so this is
 * deliberately small; it also bounds the damage of a chain that is merely
 * long rather than cyclic.
 */
export const MAX_TEMPLATE_DEPTH = 4;

/**
 * Load + validate a scenario file (`.yaml`, `.yml`, or `.json`).
 *
 * A scenario without a `name` (from itself or any template) is named after its
 * file stem, the last segment of its catalogue id, so every loaded scenario
 * has one and run directories and logs never fall back to a generic label.
 */
export async function loadScenario(file: string): Promise<Scenario & { name: string }> {
  const path = resolve(file);
  const { template, ...scenarioFields } = await readScenarioFile(path, "scenario", file);

  const templateFields = template
    ? await loadTemplate(template, path, `scenario '${file}'`, file, [path])
    : {};

  const parsed = scenarioSchema.safeParse({ ...templateFields, ...scenarioFields });
  if (!parsed.success) throw validationError("scenario", file, parsed.error.issues);

  // Client commands belong to the scenario, so relative paths resolve from the
  // file that names them rather than the template or whichever directory
  // launched Mine Labs.
  parsed.data.client.cwd = parsed.data.client.cwd
    ? resolve(dirname(path), parsed.data.client.cwd)
    : dirname(path);
  return { ...parsed.data, name: parsed.data.name ?? basename(path, extname(path)) };
}

/**
 * Read, parse and validate one scenario or template file, resolving its
 * spectator mods against itself: unlike client.cwd, a mod is an asset owned by
 * the YAML that declares it.
 */
async function readScenarioFile(
  path: string,
  kind: "scenario" | "template",
  label: string,
  referencedBy?: string,
): Promise<z.output<typeof scenarioFileSchema>> {
  const owner = referencedBy ? ` referenced by ${referencedBy}` : "";
  const raw = await readFile(path, "utf8").catch((cause: unknown) => {
    throw new ScenarioError(`cannot read ${kind} file '${label}'${owner}: ${(cause as Error).message}`);
  });
  const parsedObject = await Promise.resolve(raw)
    .then((contents) => (extname(path) === ".json" ? JSON.parse(contents) : yamlParse(contents)))
    .catch((cause: unknown) => {
      throw new ScenarioError(`${kind} '${label}'${owner} is not valid YAML/JSON: ${(cause as Error).message}`);
    });
  const validated = scenarioFileSchema.safeParse(parsedObject);
  if (!validated.success) throw validationError(kind, label, validated.error.issues, referencedBy);
  const fields = validated.data;
  if (fields.spectator) {
    fields.spectator.mods = fields.spectator.mods.map((mod) => ({
      ...mod, path: resolve(dirname(path), mod.path),
    }));
  }
  return fields;
}

/**
 * Resolve one `template:` reference, and any template it names in turn, into
 * a single set of defaults. Each level merges exactly as a scenario merges
 * over its template — a field it names replaces the inherited one whole — so
 * a chain is the same rule applied repeatedly, not a second merge policy.
 *
 * `chain` holds every file already on the path, the scenario included, so a
 * template that leads back to any of them is reported as the cycle it is.
 */
async function loadTemplate(
  reference: string,
  fromPath: string,
  referencedBy: string,
  scenarioFile: string,
  chain: readonly string[],
): Promise<ScenarioTemplate> {
  const templatePath = resolve(dirname(fromPath), reference);
  if (chain.includes(templatePath)) {
    const loop = [...chain.slice(chain.indexOf(templatePath)), templatePath].join(" -> ");
    throw new ScenarioError(`scenario '${scenarioFile}' has a template cycle: ${loop}`);
  }
  // `chain` is the scenario plus the templates above this one.
  if (chain.length > MAX_TEMPLATE_DEPTH) {
    throw new ScenarioError(
      `scenario '${scenarioFile}' nests templates more than ${MAX_TEMPLATE_DEPTH} deep: `
        + [...chain.slice(1), templatePath].join(" -> "),
    );
  }
  const { template, ...fields } = await readScenarioFile(templatePath, "template", templatePath, referencedBy);
  if (!template) return fields;
  const inherited = await loadTemplate(
    template,
    templatePath,
    `template '${templatePath}' (from scenario '${scenarioFile}')`,
    scenarioFile,
    [...chain, templatePath],
  );
  return { ...inherited, ...fields };
}

function validationError(
  kind: "scenario" | "template",
  file: string,
  issues: readonly z.core.$ZodIssue[],
  referencedBy?: string,
): ScenarioError {
  const owner = referencedBy ? ` referenced by ${referencedBy}` : "";
  const detail = issues
    .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("\n");
  return new ScenarioError(`${kind} '${file}'${owner} failed validation:\n${detail}`);
}
