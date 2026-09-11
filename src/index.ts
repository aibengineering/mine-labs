/**
 * Public API of the `mine-labs` package (`import ... from "mine-labs"`).
 *
 * Mine Labs is usable two ways: as a CLI, and as a library someone embeds in
 * their own test runner or CI script. This file is the entire supported surface
 * of the second one - anything not re-exported here is an internal detail free
 * to change. Sibling entry points exist for the two optional layers:
 * `mine-labs/client` for writing a client in Node, `mine-labs/ui` for the
 * in-game control API.
 */

export { loadScenario, ScenarioError } from "./scenario/loader.js";
export { loadRunCatalog } from "./scenario/catalog.js";
export { runScenario, type RunOptions, type RunResult } from "./trial/run.js";
export { runVerification, type VerificationOptions, type VerificationSummary } from "./session/verification.js";
export {
  runSession,
  type SessionOptions,
  type SessionSummary,
  type SessionObserver,
  type SessionScenario,
  type TrialContext,
} from "./session/run.js";
export { SessionController, type TrialCancellation } from "./session/controller.js";
export {
  scenarioSchema,
  scenarioDefinitionSchema,
  scenarioTemplateSchema,
  goalSchema,
  type ScenarioInput,
  type Scenario,
  type ScenarioDefinitionInput,
  type ScenarioDefinition,
  type ScenarioTemplate,
  type GoalCondition,
  type GoalSpec,
  type PlayerSpec,
  type InventoryItemSpec,
  type ClientCommandSpec,
  type EntitySpec,
  type Geometry,
} from "./scenario/schema.js";
