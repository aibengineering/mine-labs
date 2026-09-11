import { compileScenario, FORCELOAD_CHUNK_LIMIT } from "../scenario/compile.js";
import type { Scenario } from "../scenario/schema.js";

/** A declared reset and bounded arena are the existing fixture restoration contract. */
export function canResetScenario(scenario: Scenario): boolean {
  if (scenario.verification || scenario.reset.length === 0) return false;
  if (!scenario.players.every(player => Array.isArray(player.pos))) return false;
  const { snapshot } = compileScenario(scenario);
  return snapshot !== null && snapshot.pin.reduce((sum, region) => sum + region.chunks, 0) <= FORCELOAD_CHUNK_LIMIT;
}

/** Omitted rules must not inherit a previous scenario's values. Time is always reapplied. */
export function worldCompatibilityKey(scenario: Scenario): string {
  return JSON.stringify({
    version: scenario.minecraft.version,
    type: scenario.world.type,
    seed: scenario.world.seed === undefined ? null : String(scenario.world.seed),
    structures: scenario.world.structures,
    difficulty: scenario.world.difficulty ?? "normal",
    spawn: scenario.world.spawn ?? null,
    gamerules: Object.entries(scenario.world.gamerules).sort(([a], [b]) => a.localeCompare(b)),
  });
}
