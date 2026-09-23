/**
 * What a scenario is allowed to ask for: the goal condition tree.
 *
 * A goal is the pass/fail question, and it is a recursive tree so that real
 * criteria ("reached the chest AND survived, OR reported success") can be
 * stated declaratively rather than as code. Recursion is the tricky part in
 * Zod, and the getter-based `all`/`any` definitions below are what let leaf
 * types keep coming straight from their own schemas instead of being manually
 * restated.
 *
 * One asymmetry is deliberate: `timeout` exists only on the root goal. A nested
 * condition with its own deadline would make the trial's overall time
 * ambiguous, so nesting decides *what* is measured and only the root decides
 * how long it is allowed to take.
 */

import { z } from "zod";
import { absolutePosSchema, blockPosSchema } from "./position-schema.js";

// Every leaf may be attributed to a declared player. World observations remain
// independent: attribution does not let a client assert that the world changed.
const leafGoalFields = {
  who: z.string().optional(),
};

const reachGoalConditionSchema = z.strictObject({
  ...leafGoalFields,
  kind: z.literal("reach"),
  pos: absolutePosSchema,
  radius: z.number().nonnegative().optional(),
});

const killGoalConditionSchema = z.strictObject({
  ...leafGoalFields,
  kind: z.literal("kill"),
  target: z.string().min(1),
});

const entityCountGoalConditionSchema = z.strictObject({
  ...leafGoalFields,
  kind: z.literal("entityCount"),
  entity: z.string().min(1),
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().nonnegative().optional(),
});

const entityDistanceGoalConditionSchema = z.strictObject({
  ...leafGoalFields,
  kind: z.literal("entityDistance"),
  entity: z.string().min(1),
  distance: z.number().positive(),
});

const hasItemGoalConditionSchema = z.strictObject({
  ...leafGoalFields,
  kind: z.literal("hasItem"),
  item: z.string().min(1),
  count: z.number().int().positive().optional(),
});

const blockAtGoalConditionSchema = z.strictObject({
  ...leafGoalFields,
  kind: z.literal("blockAt"),
  pos: blockPosSchema,
  block: z.string().min(1),
});

const blocksAtGoalConditionSchema = z.strictObject({
  ...leafGoalFields,
  kind: z.literal("blocksAt"),
  block: z.string().min(1),
  positions: z.array(blockPosSchema).min(1),
});

const healthGoalConditionSchema = z.strictObject({
  ...leafGoalFields,
  kind: z.literal("health"),
  health: z.number().optional(),
});

const chatGoalConditionSchema = z.strictObject({
  ...leafGoalFields,
  kind: z.literal("chat"),
  contains: z.union([z.string(), z.array(z.string()).min(1)]),
});

const completionGoalConditionSchema = z.strictObject({
  ...leafGoalFields,
  kind: z.literal("completion"),
});

const surviveGoalConditionSchema = z.strictObject({
  ...leafGoalFields,
  kind: z.literal("survive"),
  seconds: z.number().positive(),
});

const leafGoalConditionSchema = z.discriminatedUnion("kind", [
  reachGoalConditionSchema,
  killGoalConditionSchema,
  entityCountGoalConditionSchema,
  entityDistanceGoalConditionSchema,
  hasItemGoalConditionSchema,
  blockAtGoalConditionSchema,
  blocksAtGoalConditionSchema,
  healthGoalConditionSchema,
  chatGoalConditionSchema,
  completionGoalConditionSchema,
  surviveGoalConditionSchema,
]);
type LeafGoalCondition = z.infer<typeof leafGoalConditionSchema>;

/** One observable condition. Timeouts are deliberately absent from nested conditions. */
export type GoalCondition =
  | LeafGoalCondition
  | { kind: "all"; goals: GoalCondition[] }
  | { kind: "any"; goals: GoalCondition[] };

// Only the recursive links need an explicit type. All leaf types still come
// directly from their schemas, avoiding the duplicated field list Zod 3 needed.
const allGoalConditionSchema = z.strictObject({
  kind: z.literal("all"),
  get goals(): z.ZodArray<z.ZodType<GoalCondition>> {
    return z.array(goalConditionSchema).min(1);
  },
});

const anyGoalConditionSchema = z.strictObject({
  kind: z.literal("any"),
  get goals(): z.ZodArray<z.ZodType<GoalCondition>> {
    return z.array(goalConditionSchema).min(1);
  },
});

const goalConditionSchema: z.ZodType<GoalCondition> = z.discriminatedUnion("kind", [
  leafGoalConditionSchema,
  allGoalConditionSchema,
  anyGoalConditionSchema,
]);

const rootGoalFields = {
  timeout: z.number().positive().optional(),
};

/** A recursive goal condition plus the runner timeout for settling the whole trial. */
export const goalSchema = z.discriminatedUnion("kind", [
  reachGoalConditionSchema.extend(rootGoalFields),
  killGoalConditionSchema.extend(rootGoalFields),
  entityCountGoalConditionSchema.extend(rootGoalFields),
  entityDistanceGoalConditionSchema.extend(rootGoalFields),
  hasItemGoalConditionSchema.extend(rootGoalFields),
  blockAtGoalConditionSchema.extend(rootGoalFields),
  blocksAtGoalConditionSchema.extend(rootGoalFields),
  healthGoalConditionSchema.extend(rootGoalFields),
  chatGoalConditionSchema.extend(rootGoalFields),
  completionGoalConditionSchema.extend(rootGoalFields),
  surviveGoalConditionSchema.extend(rootGoalFields),
  allGoalConditionSchema.extend(rootGoalFields),
  anyGoalConditionSchema.extend(rootGoalFields),
]).superRefine(validateGoalTree);
export type GoalSpec = z.infer<typeof goalSchema>;

function validateGoalTree(goal: GoalSpec, context: z.RefinementCtx): void {
  const visit = (condition: GoalCondition, path: Array<string | number>): void => {
    if (
      condition.kind === "entityCount"
      && condition.min !== undefined
      && condition.max !== undefined
      && condition.min > condition.max
    ) {
      context.addIssue({
        code: "custom",
        path: [...path, "min"],
        message: "minimum cannot exceed maximum",
      });
    }

    if (condition.kind === "all" || condition.kind === "any") {
      condition.goals.forEach((child, index) => visit(child, [...path, "goals", index]));
    }
  };

  visit(goal, []);
}
