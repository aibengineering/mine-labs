/**
 * What a scenario *is*: the validated shape of a scenario file.
 *
 * Scenarios are written by hand in YAML, so nearly every failure mode is a
 * typo, and the difference between a good harness and an infuriating one is
 * whether that typo is reported at load time with a path, or surfaces an hour
 * later as a trial that behaved oddly. These schemas are `strictObject`
 * throughout for exactly that reason - an unknown key is a mistake, not an
 * extension point - and defaults are declared here so a minimal scenario file
 * stays minimal.
 *
 * Three related shapes come out of this module, and the distinction matters:
 * - `scenarioTemplateSchema` - every field optional, for a shared defaults file
 *   that must be able to *not* mention something.
 * - `scenarioSchema` - a complete scenario after template merge and defaults.
 * - `scenarioDefinitionSchema` - the same thing minus `client`, which is what a
 *   client process is told about itself. A client is never handed the command
 *   line used to launch it.
 */

import { z } from "zod";
import { goalSchema, type GoalCondition, type GoalSpec } from "./goal-schema.js";
import {
  absolutePosSchema,
  posSchema,
  posToCommand,
  type AbsolutePos,
  type Pos,
} from "./position-schema.js";

export {
  absolutePosSchema,
  goalSchema,
  posSchema,
  posToCommand,
  type AbsolutePos,
  type GoalCondition,
  type GoalSpec,
  type Pos,
};

const fillGeometrySchema = z.strictObject({
  fill: z.strictObject({
    block: z.string(),
    from: posSchema,
    to: posSchema,
    mode: z.enum(["replace", "destroy", "hollow", "keep", "outline"]).optional(),
  }),
});

const setblockGeometrySchema = z.strictObject({
  setblock: z.strictObject({
    block: z.string(),
    at: posSchema,
  }),
});

const runGeometrySchema = z.strictObject({
  run: z.string(),
});

/** One declarative world edit. Exactly one operation must be present. */
const geometrySchema = z.union([
  fillGeometrySchema,
  setblockGeometrySchema,
  runGeometrySchema,
]);
export type Geometry = z.infer<typeof geometrySchema>;

const entitySchema = z.strictObject({
  /** Entity type id, e.g. `zombie` or `minecraft:zombie`. */
  type: z.string(),
  pos: posSchema,
  /** Raw SNBT compound appended to the summon command. */
  nbt: z.string().optional(),
});
export type EntitySpec = z.infer<typeof entitySchema>;

const minecraftResourceId = /^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/u;

const inventoryItemSchema = z.strictObject({
  item: z.string().regex(minecraftResourceId, "inventory item must be a Minecraft resource id"),
  count: z.number().int().positive().max(9_999).default(1),
});
export type InventoryItemSpec = z.infer<typeof inventoryItemSchema>;

const clientCommandSchema = z.strictObject({
  /** Executable that speaks the Mine Labs JSON-lines client protocol. */
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Environment values added to the inherited process environment. */
  env: z.record(z.string(), z.string()).default({}),
  /** Working directory for the client process. Defaults to the scenario file's directory. */
  cwd: z.string().optional(),
});
export type ClientCommandSpec = z.infer<typeof clientCommandSchema>;

const playerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]{3,16}$/, "player name must be 3-16 chars of [A-Za-z0-9_]");

const playerSpecSchema = z.strictObject({
  name: playerNameSchema,
  pos: posSchema.optional(),
  /** Items Mine Labs gives after reusable-player cleanup and before ctx.start. */
  inventory: z.array(inventoryItemSchema).default([]),
  /** Grant operator rights to the client player as part of scenario setup. */
  op: z.boolean().default(false),
  /**
   * Health the player starts the trial with, out of 20. A wounded fixture
   * declares it here rather than having its driver hurt itself, so the
   * arrangement is visible in the scenario and finished before `start`.
   */
  health: z.number().min(1).max(20).optional(),
});
export type PlayerSpec = z.infer<typeof playerSpecSchema>;

const minecraftSchema = z.strictObject({
  version: z.string().default("1.21.4"),
});

/** A vanilla dimension, with or without its `minecraft:` namespace. */
export const dimensionSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.replace(/^minecraft:/u, "") : value),
  z.enum(["overworld", "the_nether", "the_end"]),
);
export type Dimension = z.output<typeof dimensionSchema>;

const worldSchema = z.strictObject({
  type: z.enum(["flat", "default"]).default("flat"),
  /**
   * Where the arena is. Every coordinate a scenario declares — geometry,
   * entities, players, `setup`, `reset`, `tick` and block goals — is in this
   * dimension, and Mine Labs points its rcon commands there. Player goals
   * follow the named player wherever it is.
   */
  dimension: dimensionSchema.default("overworld"),
  difficulty: z.enum(["peaceful", "easy", "normal", "hard"]).optional(),
  seed: z.union([z.number(), z.string()]).optional(),
  /** Generate vanilla structures such as Nether fortresses in this world. */
  structures: z.boolean().default(false),
  spawn: posSchema.optional(),
  /** Tick number or vanilla keyword such as `day` or `noon`. */
  time: z.union([z.number(), z.string()]).default("day"),
  gamerules: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

const scenarioFields = {
  /** Opt in to shared-world verification; horizontal travel envelope around the spawn. */
  verification: z.strictObject({
    radius: z.number().positive().finite(),
    locations: z.array(absolutePosSchema).min(1),
  }).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  /** Searchable labels; folders still describe the behavior under test. */
  tags: z.array(z.string().trim().min(1)),
  minecraft: minecraftSchema,
  world: worldSchema,
  geometry: z.array(geometrySchema),
  entities: z.array(entitySchema),
  players: z.array(playerSpecSchema).min(1),
  /** Scenario-specific request data handed to the external client. */
  params: z.record(z.string(), z.unknown()),
  /** One-shot commands run before geometry when a server is reused. */
  reset: z.array(z.string()),
  /** One-shot commands run after geometry is arranged. */
  setup: z.array(z.string()),
  /** Commands executed every tick through a generated datapack. */
  tick: z.array(z.string()),
  goal: goalSchema,
  client: clientCommandSchema,
};

/** Partial scenario defaults loaded from a scenario's `template` file. */
export const scenarioTemplateSchema = z.strictObject(scenarioFields).partial();
export type ScenarioTemplate = z.output<typeof scenarioTemplateSchema>;

/** Scenario file before its optional template has been merged. */
export const scenarioFileSchema = scenarioTemplateSchema.extend({
  /** Reusable scenario defaults, resolved relative to the scenario file. */
  template: z.string().min(1).optional(),
});

// A template preserves absence. Defaults are applied only when the merged
// fields become a complete scenario.
const completeScenarioSchema = z.strictObject({
  ...scenarioFields,
  tags: scenarioFields.tags.default([]),
  minecraft: scenarioFields.minecraft.prefault({}),
  world: scenarioFields.world.prefault({}),
  geometry: scenarioFields.geometry.default([]),
  entities: scenarioFields.entities.default([]),
  players: scenarioFields.players.prefault([{ name: "player1" }]),
  params: scenarioFields.params.default({}),
  reset: scenarioFields.reset.default([]),
  setup: scenarioFields.setup.default([]),
  tick: scenarioFields.tick.default([]),
});

/** Complete runner input: the client-visible definition plus its launch command. */
export const scenarioSchema = completeScenarioSchema
  .superRefine(validateGoalPlayers)
  .superRefine(validatePlayerPositions);
export type ScenarioInput = z.input<typeof scenarioSchema>;
export type Scenario = z.output<typeof scenarioSchema>;

/** Parsed scenario data sent to a client, without instructions for launching itself. */
export const scenarioDefinitionSchema = completeScenarioSchema
  .omit({ client: true })
  .superRefine(validateGoalPlayers)
  .superRefine(validatePlayerPositions);
export type ScenarioDefinitionInput = z.input<typeof scenarioDefinitionSchema>;
export type ScenarioDefinition = z.output<typeof scenarioDefinitionSchema>;

/**
 * A player joins in the overworld. Outside it, the only thing that moves a
 * player into the arena is the declared `pos`, so a scenario there must give
 * every player one — otherwise the client would be measured in the wrong
 * dimension while looking, from the log, like it simply never moved.
 */
function validatePlayerPositions(
  scenario: { world: { dimension: Dimension }; players: PlayerSpec[] },
  context: z.RefinementCtx,
): void {
  if (scenario.world.dimension === "overworld") return;
  scenario.players.forEach((player, index) => {
    if (player.pos !== undefined) return;
    context.addIssue({
      code: "custom",
      path: ["players", index, "pos"],
      message: `player '${player.name}' needs a pos: the scenario is in ${scenario.world.dimension} and a player joins in the overworld`,
    });
  });
}

function validateGoalPlayers(
  scenario: { players: PlayerSpec[]; goal: GoalSpec },
  context: z.RefinementCtx,
): void {
  const players = new Set(scenario.players.map(({ name }) => name));

  const visit = (goal: GoalCondition, path: Array<string | number>): void => {
    if ("who" in goal && goal.who !== undefined && !players.has(goal.who)) {
      context.addIssue({
        code: "custom",
        path: [...path, "who"],
        message: `unknown player '${goal.who}'`,
      });
    }
    if (goal.kind === "all" || goal.kind === "any") {
      goal.goals.forEach((child, index) => visit(child, [...path, "goals", index]));
    }
  };

  visit(scenario.goal, ["goal"]);
}
