/**
 * Read a scenario file off disk and turn it into a validated `Scenario`.
 *
 * The work that is not obvious from the name is all about error quality and
 * path resolution. Every failure - unreadable file, malformed YAML, schema
 * violation - is reported as a `ScenarioError` naming the file, the field path,
 * and, when a template was involved, which scenario pulled it in. A scenario
 * author should never have to guess which of two files a message is about.
 *
 * Templates let a suite share defaults: the template supplies fields it names,
 * the scenario overrides them, and schema defaults apply only once the merged
 * result is complete - which is why the template is validated as fully-optional
 * and the merge is validated again as a whole.
 *
 * Relative paths in `client.cwd` resolve against the scenario file, not the
 * process's working directory, so a suite behaves the same wherever it is run
 * from.
 */

import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { parse as yamlParse } from "yaml";
import type { z } from "zod";
import {
  scenarioFileSchema,
  scenarioTemplateSchema,
  scenarioSchema,
  type Scenario,
  type ScenarioTemplate,
} from "./schema.js";

export class ScenarioError extends Error {}

/** Load + validate a scenario file (`.yaml`, `.yml`, or `.json`). */
export async function loadScenario(file: string): Promise<Scenario> {
  const path = resolve(file);
  const raw = await readFile(path, "utf8").catch((cause: unknown) => {
    throw new ScenarioError(`cannot read scenario file '${file}': ${(cause as Error).message}`);
  });
  const parsedObject = await Promise.resolve(raw)
    .then((contents) => (extname(path) === ".json" ? JSON.parse(contents) : yamlParse(contents)))
    .catch((cause: unknown) => {
      throw new ScenarioError(`scenario '${file}' is not valid YAML/JSON: ${(cause as Error).message}`);
    });

  const validatedObject = scenarioFileSchema.safeParse(parsedObject);
  if (!validatedObject.success) throw validationError("scenario", file, validatedObject.error.issues);

  const { template, ...scenarioFields } = validatedObject.data;
  let templateFields: ScenarioTemplate = {};
  if (template) {
    const templatePath = resolve(dirname(path), template);
    const rawTemplate = await readFile(templatePath, "utf8")
      .catch((cause: unknown) => {
        throw new ScenarioError(
          `cannot read template file '${templatePath}' referenced by scenario '${file}': ${(cause as Error).message}`,
        );
      });
    const parsedTemplate = await Promise.resolve(rawTemplate)
      .then((contents) => (extname(templatePath) === ".json" ? JSON.parse(contents) : yamlParse(contents)))
      .catch((cause: unknown) => {
        throw new ScenarioError(
          `template '${templatePath}' referenced by scenario '${file}' is not valid YAML/JSON: ${(cause as Error).message}`,
        );
      });
    const validatedTemplate = scenarioTemplateSchema.safeParse(parsedTemplate);
    if (!validatedTemplate.success) {
      throw validationError("template", templatePath, validatedTemplate.error.issues, file);
    }
    templateFields = validatedTemplate.data;
    if (templateFields.spectator) {
      templateFields.spectator.mods = templateFields.spectator.mods.map((mod) => ({
        ...mod, path: resolve(dirname(templatePath), mod.path),
      }));
    }
  }

  // Unlike client.cwd, a mod is an asset owned by the YAML that declares it.
  if (scenarioFields.spectator) {
    scenarioFields.spectator.mods = scenarioFields.spectator.mods.map((mod) => ({
      ...mod, path: resolve(dirname(path), mod.path),
    }));
  }

  const parsed = scenarioSchema.safeParse({ ...templateFields, ...scenarioFields });
  if (!parsed.success) throw validationError("scenario", file, parsed.error.issues);

  // Client commands belong to the scenario, so relative paths resolve from the
  // file that names them rather than the template or whichever directory
  // launched Mine Labs.
  parsed.data.client.cwd = parsed.data.client.cwd
    ? resolve(dirname(path), parsed.data.client.cwd)
    : dirname(path);
  return parsed.data;
}

function validationError(
  kind: "scenario" | "template",
  file: string,
  issues: readonly z.core.$ZodIssue[],
  scenarioFile?: string,
): ScenarioError {
  const owner = scenarioFile ? ` referenced by scenario '${scenarioFile}'` : "";
  const detail = issues
    .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("\n");
  return new ScenarioError(`${kind} '${file}'${owner} failed validation:\n${detail}`);
}
