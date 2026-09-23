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
const EQUIPMENT_SLOTS = {
  head: "armor.head", chest: "armor.chest", legs: "armor.legs", feet: "armor.feet",
  mainhand: "weapon.mainhand", offhand: "weapon.offhand",
} as const;

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
  // Equip first so a main-hand declaration cannot overwrite an inventory grant.
  for (const [slot, item] of Object.entries(player.equipment ?? {})) {
    const target = EQUIPMENT_SLOTS[slot as keyof typeof EQUIPMENT_SLOTS];
    await commands.command(`item replace entity ${player.name} ${target} with ${resourceId(item)} 1`);
  }
  for (const stack of player.inventory) {
    await commands.command(`give ${player.name} ${resourceId(stack.item)} ${stack.count}`);
  }
  if (player.op) await commands.command(`op ${player.name}`);
  const teleport = player.pos
    ? inDimension(options.dimension ?? "overworld", `tp ${player.name} ${posToCommand(player.pos)}`)
    : null;
  if (options.resetReusablePlayer) {
    // Still a spectator, so the rejoin cell cannot burn or hurt it on the way out.
    if (teleport) await commands.command(teleport);
    await returnReusablePlayer(commands, player.name);
    // After the vitals restore, so a reused body is wounded from full health
    // rather than from whatever the last trial left it with.
    await woundToDeclaredHealth(commands, player);
    return;
  }
  // Before the teleport: for a moment after a change of dimension the player
  // is in neither level, and a command aimed at it then finds nobody.
  await woundToDeclaredHealth(commands, player);
  if (teleport) await commands.command(teleport);
}

/** Magic damage ignores armour, so the declared inventory cannot change the result. */
async function woundToDeclaredHealth(commands: PlayerCommandHost, player: PlayerSpec): Promise<void> {
  if (player.health !== undefined && player.health < 20) {
    await commands.command(`damage ${player.name} ${20 - player.health} minecraft:magic`);
  }
}

/**
 * A reused server keeps the player's body across trials, and it rejoins where
 * the last trial left it — a cell the restored arena may have filled with lava
 * again. Lava fire is entity NBT that `effect clear` cannot touch, and vanilla
 * refuses `/data merge` on players. Spectator mode first: a spectator takes no
 * lava damage, catches no fire, and its fire goes out within a few ticks.
 */
async function resetReusablePlayer(commands: PlayerCommandHost, name: string): Promise<void> {
  await commands.command(`gamemode spectator ${name}`);
  await commands.command(`clear ${name}`);
  await commands.command(`effect clear ${name}`);
  await commands.command(`deop ${name}`);
  const listed = await commands.command(`tag ${name} list`);
  for (const tag of parseListedTags(listed)) await commands.command(`tag ${name} remove ${tag}`);
}

const RETURN_POLL_ATTEMPTS = 100;
const RETURN_POLL_MS = 50;

/**
 * Back to survival once the body is found and no longer burning, then restore
 * health and hunger with instant effects that clamp at their maximums: lost
 * health never regenerates on no-regeneration fixtures. Reading `Fire` also
 * waits out a change of dimension, during which the player cannot be found.
 */
async function returnReusablePlayer(commands: PlayerCommandHost, name: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const answer = await commands.command(`data get entity ${name} Fire`);
    const ticks = /(-?\d+)s\s*$/u.exec(answer.trim())?.[1];
    if (ticks !== undefined && Number(ticks) <= 0) break;
    if (attempt >= RETURN_POLL_ATTEMPTS) {
      throw new Error(`${name} could not return to survival after ${RETURN_POLL_ATTEMPTS * RETURN_POLL_MS} ms: ${answer}`);
    }
    await new Promise((resolve) => setTimeout(resolve, RETURN_POLL_MS));
  }
  await commands.command(`gamemode survival ${name}`);
  await commands.command(`effect give ${name} minecraft:instant_health 1 9 true`);
  await commands.command(`effect give ${name} minecraft:saturation 1 9 true`);
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
