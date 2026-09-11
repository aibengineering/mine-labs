import type { GoalCondition, Scenario } from "./schema.js";
import { posToCommand } from "./position-schema.js";

export interface InspectionGoal { label: string; children?: InspectionGoal[] }
export interface ScenarioInspection {
  name: string;
  description: string;
  timeoutSeconds: number;
  goal: InspectionGoal;
  setup: Array<{ title: string; lines: string[] }>;
  parameters: string[];
}

/** A read-only description of the validated fixture; never includes launcher environment values. */
export function inspectScenario(name: string, scenario: Scenario): ScenarioInspection {
  return {
    name, description: scenario.description ?? "No description provided.", timeoutSeconds: scenario.goal.timeout ?? 120,
    goal: inspectGoal(scenario.goal, scenario.players[0]!.name),
    setup: [
      { title: "World", lines: [
        `Minecraft ${scenario.minecraft.version} | ${scenario.world.type} world`,
        `Seed: ${scenario.world.seed ?? "generated"} | Structures: ${scenario.world.structures ? "on" : "off"}`,
        `Time: ${scenario.world.time} | Difficulty: ${scenario.world.difficulty ?? "server default"}`,
        ...Object.entries(scenario.world.gamerules).map(([key, value]) => `${key}: ${value}`),
      ] },
      { title: "Players", lines: scenario.players.flatMap(player => [
        `${player.name} | Start: ${player.pos === undefined ? "server spawn / driver setup" : posToCommand(player.pos)}`,
        `Inventory: ${player.inventory.length ? player.inventory.map(item => `${item.count} x ${item.item}`).join(", ") : "none granted"}`,
      ]) },
      { title: "Entities", lines: scenario.entities.length ? scenario.entities.map(entity =>
        `${entity.type} at ${posToCommand(entity.pos)}${entity.nbt ? ` | ${entity.nbt}` : ""}`) : ["None declared in YAML. The driver may create entities."] },
      { title: "World arrangement", lines: scenario.geometry.map(edit => "fill" in edit
        ? `Fill ${edit.fill.block}: ${posToCommand(edit.fill.from)} to ${posToCommand(edit.fill.to)} (${edit.fill.mode ?? "replace"})`
        : "setblock" in edit ? `Place ${edit.setblock.block} at ${posToCommand(edit.setblock.at)}` : edit.run) },
      ...(["setup", "tick", "reset"] as const).filter(key => scenario[key].length).map(key => ({title: `${key} commands`, lines: scenario[key]})),
      ...(scenario.verification ? [{ title: "Verification boundary", lines: [`Stay within ${scenario.verification.radius} blocks horizontally of each player's start.`] }] : []),
    ],
    parameters: Object.keys(scenario.params).length ? JSON.stringify(scenario.params, null, 2).split("\n") : ["No driver parameters declared."],
  };
}

function inspectGoal(goal: GoalCondition, firstPlayer: string): InspectionGoal {
  const who = "who" in goal ? goal.who ?? firstPlayer : firstPlayer;
  switch (goal.kind) {
    case "all": return { label: "ALL conditions must pass (AND)", children: goal.goals.map(child => inspectGoal(child, firstPlayer)) };
    case "any": return { label: "At least ONE condition must pass (OR)", children: goal.goals.map(child => inspectGoal(child, firstPlayer)) };
    case "survive": return {label: `${goal.who ?? "All scenario players"}: survive ${goal.seconds} seconds with zero recorded deaths`};
    case "completion": return {label: `${who}: driver must report successful completion (checks defined in driver code)`};
    case "reach": return {label: `${who}: reach ${posToCommand(goal.pos)} within ${goal.radius ?? 2} blocks, in the player's current dimension`};
    case "health": return {label: `${who}: health at least ${goal.health ?? 1}`};
    case "hasItem": return {label: `${who}: carry at least ${goal.count ?? 1} x ${goal.item}`};
    case "chat": return {label: `${who}: chat must contain every listed text: ${JSON.stringify(goal.contains)}`};
    case "entityDistance": return {label: `${who}: stay more than ${goal.distance} blocks from every ${goal.entity}`};
    case "entityCount": return {label: `${goal.entity}: count between ${goal.min ?? 0} and ${goal.max ?? "unlimited"}`};
    case "kill": return {label: `No ${goal.target} remaining; at least one must have been observed`};
    case "blockAt": return {label: `${goal.block} at ${goal.pos.join(", ")}`};
  }
}
