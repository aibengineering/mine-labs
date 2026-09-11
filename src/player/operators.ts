/**
 * Give configured human operators spectator mode and night vision on arrival.
 * Poll throughout the trial so late arrivals are handled too. Place them after
 * the bot is prepared, then leave their movement and gamemode alone until rejoin.
 * Scenario players retain the setup declared by their fixture.
 */

import { posToCommand, type Pos } from "../scenario/position-schema.js";

export interface OperatorCommandHost {
  command(command: string): Promise<string>;
  playerOnline(name: string): Promise<boolean>;
}

/** Horizontal offset follows the bot's yaw, even when it is looking up/down. */
export function observerCameraCommand(observer: string, player: string): string {
  // atan(4 / 6): aim down from the offset, with position and rotation in one teleport.
  return `execute at ${player} rotated ~ 0 run tp ${observer} ^ ^4 ^-6 ~ 33.69`;
}

export interface OperatorSpectatorOptions {
  commands: OperatorCommandHost;
  /** Names from the Mine Labs operator list. */
  operatorNames: readonly string[];
  /** Scenario client players, which the scenario owns and this must never touch. */
  clientPlayerNames: readonly string[];
  /** Operators already placed this trial. Mutated, so a caller can poll with it. */
  placed: Set<string>;
  /** Fallback camera position when there is no prepared player to follow. */
  viewpoint?: Pos;
  /** Prefer the prepared player's current location, including its dimension. */
  viewpointPlayer?: string;
  /** Spectator mode applies immediately; placement waits until arrangement finishes. */
  viewpointReady?: () => boolean;
}

/**
 * Place any newly present operator into spectator with night vision.
 *
 * Returns the names placed by this call, so a poller can log a human arriving
 * once rather than on every pass.
 */
export async function applyOperatorSpectatorPolicy(options: OperatorSpectatorOptions): Promise<string[]> {
  const { commands, operatorNames, clientPlayerNames, placed } = options;
  const owned = new Set(clientPlayerNames.map((name) => name.toLowerCase()));
  const placedNow: string[] = [];

  for (const name of operatorNames) {
    // A scenario client that happens to share a name with an operator is the
    // scenario's player first. Its gamemode, inventory and position belong to
    // the fixture.
    if (owned.has(name.toLowerCase())) continue;

    const online = await commands.playerOnline(name);
    if (!online) {
      // Forget them, so a rejoin is placed again rather than treated as handled.
      placed.delete(name);
      continue;
    }
    if (placed.has(name)) continue;

    await commands.command(`gamemode spectator ${name}`);
    await commands.command(`effect give ${name} minecraft:night_vision infinite 1 true`);
    if (options.viewpointReady?.() === false) continue;
    if (options.viewpointPlayer) {
      if (!await commands.playerOnline(options.viewpointPlayer)) continue;
      await commands.command(observerCameraCommand(name, options.viewpointPlayer));
    } else if (options.viewpoint !== undefined) {
      await commands.command(`tp ${name} ${posToCommand(options.viewpoint)}`);
    }
    placed.add(name);
    placedNow.push(name);
  }

  return placedNow;
}

export interface OperatorSpectatorWatchOptions extends Omit<OperatorSpectatorOptions, "placed"> {
  log: (message: string) => void;
  intervalMs?: number;
}

/**
 * Keep applying the policy for the life of a trial, with an awaited start-line pass.
 *
 * Background arrival polls retry transient failures. Explicit placement before
 * execution propagates failures so a run cannot silently start without it.
 */
export function watchOperatorSpectators(options: OperatorSpectatorWatchOptions): { place: () => Promise<void>; stop: () => void } {
  const { commands, operatorNames, clientPlayerNames, log } = options;
  if (operatorNames.length === 0) return { place: async () => {}, stop: () => {} };
  const placed = new Set<string>();
  let running = Promise.resolve();
  let stopped = false;

  const pass = async (): Promise<void> => {
    if (stopped) return;
    const placedNow = await applyOperatorSpectatorPolicy({
      commands,
      operatorNames,
      clientPlayerNames,
      placed,
      viewpoint: options.viewpoint,
      viewpointPlayer: options.viewpointPlayer,
      viewpointReady: options.viewpointReady,
    });
    for (const name of placedNow) log(`operator '${name}' joined — spectator mode, night vision and viewpoint applied`);
  };
  const place = async (): Promise<void> => {
    // A start-line placement must wait for an in-flight arrival poll, then
    // recheck readiness. It must not silently skip the requested placement.
    running = running.catch(() => {}).then(pass);
    await running;
  };
  const poll = (): void => { void place().catch(() => {}); };
  const timer = setInterval(poll, options.intervalMs ?? 2000);
  timer.unref?.();
  poll();

  return {
    place,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
