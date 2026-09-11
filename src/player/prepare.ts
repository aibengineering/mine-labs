/**
 * Put one client's player into the exact state the scenario declared.
 *
 * A trial only measures what the client did if every trial starts from the same
 * place, and a player joining a server does not arrive in a known state - even
 * less so on a reused server, where the same body carries its inventory,
 * effects, gamemode, tags and position out of the previous trial and into this
 * one.
 *
 * So this both clears the inherited state and applies the declared one, in an
 * order that matters: cleanup first, then inventory and position, all of it
 * finished before the client is ever told to start. Anything provisioned late
 * would be a race the client could observe.
 */

import type { Dimension, PlayerSpec } from "../scenario/schema.js";
import { posToCommand } from "../scenario/schema.js";
import { inDimension, resourceId } from "../util/minecraft.js";

const MINECRAFT_TAG = /^[A-Za-z0-9_.+-]+$/u;

export interface PlayerCommandHost {
  command(command: string): Promise<string>;
}

export interface PreparePlayerForTrialOptions {
  commands: PlayerCommandHost;
  player: PlayerSpec;
  /** The arena dimension a declared `pos` is in. A player joins in the overworld. */
  dimension?: Dimension;
  resetReusablePlayer: boolean;
}

/**
 * Establish the scenario-owned initial state for one connected client player.
 * Cleanup must finish before declared inventory is provisioned or ctx.start resolves.
 */
export async function preparePlayerForTrial(options: PreparePlayerForTrialOptions): Promise<void> {
  const { commands, player } = options;
  if (options.resetReusablePlayer) await resetReusablePlayer(commands, player.name);
  for (const stack of player.inventory) {
    await commands.command(`give ${player.name} ${resourceId(stack.item)} ${stack.count}`);
  }
  if (player.op) await commands.command(`op ${player.name}`);
  if (options.resetReusablePlayer) await restoreReusablePlayerVitals(commands, player.name);
  // After the vitals restore, so a reused body is wounded from full health
  // rather than from whatever the last trial left it with, and before the
  // teleport: for a moment after a change of dimension the player is in
  // neither level, and a command aimed at it then finds nobody. Magic damage
  // ignores armour, so the declared inventory cannot change the result.
  if (player.health !== undefined && player.health < 20) {
    await commands.command(`damage ${player.name} ${20 - player.health} minecraft:magic`);
  }
  if (player.pos) {
    await commands.command(inDimension(options.dimension ?? "overworld", `tp ${player.name} ${posToCommand(player.pos)}`));
  }
}

async function resetReusablePlayer(commands: PlayerCommandHost, name: string): Promise<void> {
  await commands.command(`clear ${name}`);
  await commands.command(`effect clear ${name}`);
  await commands.command(`gamemode survival ${name}`);
  await commands.command(`deop ${name}`);
  const listed = await commands.command(`tag ${name} list`);
  for (const tag of parseListedTags(listed)) await commands.command(`tag ${name} remove ${tag}`);
}

/**
 * A reused server keeps the player's body across trials, so physical state
 * survives too. Lava fire is entity NBT, not a potion effect, so the
 * `effect clear` above cannot touch it — a player that ended one cycle in lava
 * started the next cycle still burning and, on a no-regeneration fixture,
 * already below its own health goal. Reset its `Fire` NBT directly, then
 * restore health and hunger with instant effects that clamp at their
 * maximums. Unlike a temporary water block, this cannot leave flowing water
 * in the scenario world.
 */
async function restoreReusablePlayerVitals(commands: PlayerCommandHost, name: string): Promise<void> {
  await commands.command(`effect give ${name} minecraft:instant_health 1 9 true`);
  await commands.command(`effect give ${name} minecraft:saturation 1 9 true`);
  await commands.command(`data merge entity ${name} {Fire:0s}`);
}

/** Parse both bracketed older responses and Minecraft 1.21.4's comma-separated tag response. */
function parseListedTags(response: string): string[] {
  const separator = response.indexOf(":");
  if (separator < 0) return [];
  return response
    .slice(separator + 1)
    .trim()
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => MINECRAFT_TAG.test(tag));
}
