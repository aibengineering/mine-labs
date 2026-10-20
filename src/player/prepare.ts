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
 * order that matters: cleanup first, then inventory, hunger, health and
 * position, all of it finished before the client is ever told to start.
 * Anything provisioned late would be a race the client could observe.
 */

import type { Dimension, PlayerSpec } from "../scenario/schema.js";
import { posToCommand } from "../scenario/schema.js";
import { inDimension, resourceId } from "../util/minecraft.js";
import { delay } from "../util/fs.js";

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
  /** How to wait between reads of a reused body's fire or hunger; tests pass one that does not sleep. */
  wait?: (ms: number) => Promise<void>;
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
    await returnReusablePlayer(commands, player.name, options.wait ?? delay);
    // After the vitals restore, so a reused body is wounded from full health
    // rather than from whatever the last trial left it with.
    await arrangeVitals(commands, player, options.wait ?? delay);
    return;
  }
  // Before the teleport: for a moment after a change of dimension the player
  // is in neither level, and a command aimed at it then finds nobody.
  await arrangeVitals(commands, player, options.wait ?? delay);
  if (teleport) await commands.command(teleport);
}

/**
 * Hunger first, at full health: a wounded body regenerates from its food bar,
 * which would move both. The wound then sends the client its vitals; without
 * one, a hunger arrangement sends them itself.
 *
 * Effects given earlier land only on the player's next tick, and a reused
 * body's restore is one, so those are waited out before anything is read or
 * dealt: a wound dealt before a pending heal lands would be healed away.
 */
async function arrangeVitals(
  commands: PlayerCommandHost,
  player: PlayerSpec,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  const wounded = player.health !== undefined && player.health < 20;
  const hungry = player.food !== undefined || player.saturation !== undefined;
  if (!wounded && !hungry) return;
  await settleEffects(commands, player.name, wait);
  if (hungry) await arrangeHunger(commands, player, wait);
  if (wounded) await damageUntilApplied(commands, player.name, 20 - player.health!, wait);
  else await resendVitals(commands, player.name, wait);
}

/**
 * Magic damage ignores armour, so the declared inventory cannot change the
 * result, and costs no exhaustion. A player who has just joined is immune to
 * damage for a few seconds, and vanilla answers that with a refusal rather
 * than an error, so the command is repeated until it lands.
 */
async function damageUntilApplied(
  commands: PlayerCommandHost,
  name: string,
  amount: number,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const answer = await commands.command(`damage ${name} ${amount} minecraft:magic`);
    if (/^Applied /u.test(answer)) return;
    if (attempt * VITALS_POLL_MS >= VITALS_TIMEOUT_MS) {
      throw new Error(`${name} could not be dealt its starting damage within ${VITALS_TIMEOUT_MS} ms: ${answer}`);
    }
    await wait(VITALS_POLL_MS);
  }
}

/** A food level and saturation, as the server holds them. */
export interface HungerState {
  food: number;
  saturation: number;
}

/** One step towards a declared hunger state. */
export type HungerMove = { kind: "done" } | { kind: "drain" } | { kind: "raise"; food: number };

/**
 * The next step from `state` towards `target`, using the only two levers
 * vanilla offers on a player. Draining (exhaustion from the hunger effect)
 * takes one point at a time: saturation first, then food once saturation is
 * empty. Raising (one application of the saturation effect) adds `food`
 * points of food and twice that of saturation, both capped: food at 20 and
 * saturation at the new food level. So a target with saturation is reached by
 * raising onto the target food level with at least enough saturation, then
 * draining saturation down to it; and when a raise cannot carry that much
 * saturation, by draining further first.
 */
export function nextHungerMove(state: HungerState, target: HungerState): HungerMove {
  if (state.food === target.food && state.saturation === target.saturation) return { kind: "done" };
  if (state.food === target.food && state.saturation > target.saturation) return { kind: "drain" };
  if (state.food < target.food) {
    const food = target.food - state.food;
    if (Math.min(state.saturation + 2 * food, target.food) >= target.saturation) return { kind: "raise", food };
  }
  return { kind: "drain" };
}

const VITALS_POLL_MS = 50;
const VITALS_TIMEOUT_MS = 15_000;
// Long enough for the server to tick, and send a wound, before the heal.
const RESEND_HOLD_MS = 150;

/**
 * Bring the player's food and saturation to the declared values, reading
 * them back after every step. A drain can overshoot by a point while the
 * hunger effect is being cleared; the next reading sees that and steps back.
 * The target must still hold a tick later before it counts as reached.
 */
async function arrangeHunger(
  commands: PlayerCommandHost,
  player: PlayerSpec,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  const name = player.name;
  const target = { food: player.food ?? 20, saturation: player.saturation ?? 0 };
  const deadline = Date.now() + VITALS_TIMEOUT_MS;
  let draining = false;
  let confirming = false;
  let reads = 0;
  try {
    for (;;) {
      const state = await readHunger(commands, name);
      const move = state ? nextHungerMove(state, target) : undefined;
      if (move?.kind === "done" && !draining) {
        if (confirming) return;
        confirming = true;
        await wait(VITALS_POLL_MS);
        continue;
      }
      confirming = false;
      reads += 1;
      if (Date.now() > deadline || reads > VITALS_TIMEOUT_MS / VITALS_POLL_MS) {
        const at = state ? `food ${state.food}, saturation ${state.saturation}` : "unreadable";
        throw new Error(
          `${name} did not reach food ${target.food} and saturation ${target.saturation} `
            + `within ${VITALS_TIMEOUT_MS} ms (at ${at}); food cannot drain on peaceful`,
        );
      }
      if (move?.kind === "drain") {
        if (!draining) await commands.command(`effect give ${name} minecraft:hunger infinite 255 true`);
        draining = true;
      } else if (move && draining) {
        // Done, or about to raise: stop draining, then read again, since a
        // point may have gone between that reading and this command.
        await commands.command(`effect clear ${name} minecraft:hunger`);
        draining = false;
        continue;
      } else if (move?.kind === "raise") {
        await commands.command(`effect give ${name} minecraft:saturation 1 ${move.food - 1} true`);
        await settleEffects(commands, name, wait);
        continue;
      }
      await wait(VITALS_POLL_MS);
    }
  } finally {
    if (draining) await commands.command(`effect clear ${name} minecraft:hunger`);
  }
}

/** The player's food and saturation, or undefined while it cannot be found. */
async function readHunger(commands: PlayerCommandHost, name: string): Promise<HungerState | undefined> {
  const food = entityNumber(await commands.command(`data get entity ${name} foodLevel`));
  const saturation = entityNumber(await commands.command(`data get entity ${name} foodSaturationLevel`));
  return food === undefined || saturation === undefined ? undefined : { food, saturation };
}

/** The number in a `data get entity` answer such as `Bot has the following entity data: 5.0f`. */
function entityNumber(answer: string): number | undefined {
  const value = /entity data: (-?\d+(?:\.\d+)?(?:E-?\d+)?)[bsfdL]?$/u.exec(answer.trim())?.[1];
  return value === undefined ? undefined : Number(value);
}

/**
 * Wait until the player has no active effects. An instant effect is applied,
 * and then removed, on the player's next tick, so this is how to know one
 * given over rcon has actually landed.
 */
async function settleEffects(commands: PlayerCommandHost, name: string, wait: (ms: number) => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const answer = await commands.command(`data get entity ${name} active_effects`);
    if (/^Found no elements/u.test(answer.trim())) return;
    if (attempt * VITALS_POLL_MS >= VITALS_TIMEOUT_MS) {
      throw new Error(`${name} still had effects pending after ${VITALS_TIMEOUT_MS} ms: ${answer}`);
    }
    await wait(VITALS_POLL_MS);
  }
}

/**
 * The game sends a client its food and saturation only with a change of
 * health or food, or saturation reaching or leaving zero, so a drain that
 * moved saturation alone would leave the client seeing the old value. A
 * point of magic damage, held for a few ticks, then an instant heal send the
 * arranged values twice. A body hurt this briefly does not regenerate from
 * its food bar.
 */
async function resendVitals(commands: PlayerCommandHost, name: string, wait: (ms: number) => Promise<void>): Promise<void> {
  await damageUntilApplied(commands, name, 1, wait);
  await wait(RESEND_HOLD_MS);
  await commands.command(`effect give ${name} minecraft:instant_health 1 0 true`);
  await settleEffects(commands, name, wait);
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
async function returnReusablePlayer(
  commands: PlayerCommandHost,
  name: string,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const answer = await commands.command(`data get entity ${name} Fire`);
    const ticks = /(-?\d+)s\s*$/u.exec(answer.trim())?.[1];
    if (ticks !== undefined && Number(ticks) <= 0) break;
    if (attempt >= RETURN_POLL_ATTEMPTS) {
      throw new Error(`${name} could not return to survival after ${RETURN_POLL_ATTEMPTS * RETURN_POLL_MS} ms: ${answer}`);
    }
    await wait(RETURN_POLL_MS);
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
