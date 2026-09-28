/**
 * How a session names a scenario in its results and UI: catalog id, else its
 * own name. Its own module because both `run.ts` and the client worker it
 * creates need it; defining it in either would make the two import each other.
 */
import type { SessionScenario } from "./run.js";

export function sessionScenarioName(entry: SessionScenario): string {
  return entry.id ?? entry.scenario.name ?? "scenario";
}
