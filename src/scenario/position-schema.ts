/**
 * Coordinates, shared by the scenario schema and the goal schema.
 *
 * This is a separate file for a structural reason rather than a stylistic one:
 * `schema.ts` imports `goal-schema.ts`, and `goal-schema.ts` needs positions
 * too. Defining them here gives both a common leaf to depend on instead of a
 * cycle between them.
 *
 * The distinction it draws is load-bearing. World *edits* may use any Minecraft
 * coordinate syntax including relative `~ ~1 ~`, but anything Mine Labs must
 * later observe - where a goal says the player has to reach - has to be
 * absolute, because an observation made over RCON has no executor to resolve
 * relative coordinates against.
 */

import { z } from "zod";

/** Numeric coordinates used when Mine Labs must observe a precise world position. */
export const absolutePosSchema = z.tuple([z.number(), z.number(), z.number()]);
export type AbsolutePos = z.infer<typeof absolutePosSchema>;

// Block observations address whole cells; player positions may remain fractional.
export const blockPosSchema = z.tuple([
  z.number().int().safe(),
  z.number().int().safe(),
  z.number().int().safe(),
]);

/** A precise position or raw Minecraft command coordinates such as `~ ~1 ~`. */
export const posSchema = z.union([absolutePosSchema, z.string()]);
export type Pos = z.infer<typeof posSchema>;

export function posToCommand(pos: Pos): string {
  return Array.isArray(pos) ? pos.join(" ") : pos;
}
