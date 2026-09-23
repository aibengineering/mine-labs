/**
 * Decide whether a scenario's goal has been met, by looking at the world.
 *
 * This is where the harness's central commitment lives: a goal is judged from
 * server-side observation, not from what the client says about itself. A client
 * that claims success is only believed for the one condition kind that is
 * explicitly about self-reporting (`completion`); everything else is checked
 * against the actual world over RCON, so a broken or dishonest client cannot
 * pass a scenario it did not complete.
 *
 * `kill` shows why observation alone is not enough. "No zombies remain" is also
 * true of a world where zombies never spawned, so the goal additionally
 * requires having *seen* the target exist - the state sampled before clients
 * start, and updated on every poll.
 *
 * Evaluation is over an interface rather than the concrete `Rcon` class, so the
 * whole judging layer is testable against a fake without a Minecraft server.
 */

import type { Dimension, GoalCondition } from "../scenario/schema.js";
import { posToCommand } from "../scenario/schema.js";
import type { ClientCompletion } from "../client/protocol.js";

export interface GoalObserver {
  countEntities(type: string): Promise<number>;
  playerWithin(name: string, pos: readonly [number, number, number], radius: number): Promise<boolean>;
  playerFarFromEntities(name: string, type: string, distance: number): Promise<boolean>;
  countPlayerItems(name: string, item: string): Promise<number>;
  blockMatches(pos: readonly [number, number, number], block: string, dimension: Dimension): Promise<boolean>;
  playerHealth(name: string): Promise<number>;
  playerDeaths(name: string): Promise<number>;
}

export interface GoalContext {
  players: readonly string[];
  /** Where the scenario's block coordinates are. Player goals follow the player instead. */
  dimension: Dimension;
  observer: GoalObserver;
  /** Player name -> captured chat lines reported by its client process. */
  chat: Map<string, string[]>;
  /** client name -> first terminal completion reported by its process. */
  completions: ReadonlyMap<string, ClientCompletion>;
  startedAt: number;
  /** mutable per-goal scratch state (keyed by goal identity). */
  state: Map<GoalCondition, Record<string, unknown>>;
}

export interface GoalResult {
  state: "pending" | "passed" | "failed";
  detail: string;
  children?: GoalResult[];
}

/** Capture kill targets that actually exist immediately before clients start. */
export async function observeInitialGoalState(
  goal: GoalCondition,
  observer: GoalObserver,
  state = new Map<GoalCondition, Record<string, unknown>>(),
): Promise<Map<GoalCondition, Record<string, unknown>>> {
  if (goal.kind === "kill") {
    if ((await observer.countEntities(goal.target)) > 0) state.set(goal, { saw: true });
    return state;
  }
  if (goal.kind === "all" || goal.kind === "any") {
    for (const child of goal.goals) await observeInitialGoalState(child, observer, state);
  }
  return state;
}

function observed(condition: boolean, detail: string): GoalResult {
  return { state: condition ? "passed" : "pending", detail };
}

function pickPlayer(ctx: GoalContext, goal: { who?: string }): string | undefined {
  return goal.who ?? ctx.players[0];
}

export async function evaluateGoal(goal: GoalCondition, ctx: GoalContext): Promise<GoalResult> {
  switch (goal.kind) {
    case "reach": {
      const player = pickPlayer(ctx, goal);
      if (!player) return { state: "pending", detail: "no client player" };
      const radius = goal.radius ?? 2;
      const reached = await ctx.observer.playerWithin(player, goal.pos, radius);
      return observed(reached, `${player} ${reached ? "within" : "outside"} ${radius} blocks of target`);
    }
    case "kill": {
      const type = goal.target;
      const st = ctx.state.get(goal) ?? {};
      const count = await ctx.observer.countEntities(type);
      if (count > 0) st.saw = true;
      ctx.state.set(goal, st);
      return {
        state: Boolean(st.saw) && count === 0 ? "passed" : "pending",
        detail: `${type} remaining: ${count}${st.saw ? "" : " (none spawned yet)"}`,
      };
    }
    case "entityCount": {
      const type = goal.entity;
      const count = await ctx.observer.countEntities(type);
      const min = goal.min ?? 0;
      const max = goal.max ?? Number.MAX_SAFE_INTEGER;
      return observed(count >= min && count <= max, `${type} count: ${count} (want ${min}..${max === Number.MAX_SAFE_INTEGER ? "∞" : max})`);
    }
    case "entityDistance": {
      const player = pickPlayer(ctx, goal);
      if (!player) return { state: "pending", detail: "no client player" };
      const separated = await ctx.observer.playerFarFromEntities(player, goal.entity, goal.distance);
      return observed(
        separated,
        `${player} ${separated ? "clear of" : "within"} ${goal.distance} blocks of ${goal.entity}`,
      );
    }
    case "hasItem": {
      const player = pickPlayer(ctx, goal);
      if (!player) return { state: "pending", detail: "no client player" };
      const wanted = goal.item.toLowerCase();
      const have = await ctx.observer.countPlayerItems(player, wanted);
      const need = goal.count ?? 1;
      return observed(have >= need, `${wanted}: ${have}/${need}`);
    }
    case "blockAt": {
      const wanted = goal.block.toLowerCase().replace(/^minecraft:/u, "");
      const matches = await ctx.observer.blockMatches(goal.pos, wanted, ctx.dimension);
      return observed(matches, `${goal.pos.join(",")} ${matches ? "is" : "is not"} ${wanted}`);
    }
    case "blocksAt": {
      const wanted = goal.block.toLowerCase().replace(/^minecraft:/u, "");
      const mismatches: string[] = [];
      for (const pos of goal.positions) {
        const matches = await ctx.observer.blockMatches(pos, wanted, ctx.dimension);
        if (!matches) mismatches.push(pos.join(","));
      }
      const matched = goal.positions.length - mismatches.length;
      const mismatchDetail = mismatches.length > 0 ? `; wrong at ${mismatches.join("; ")}` : "";
      return observed(
        mismatches.length === 0,
        `${wanted}: ${matched}/${goal.positions.length} positions match${mismatchDetail}`,
      );
    }
    case "health": {
      const player = pickPlayer(ctx, goal);
      if (!player) return { state: "pending", detail: "no client player" };
      const health = await ctx.observer.playerHealth(player);
      return observed(health >= (goal.health ?? 1), `${player} health ${health}`);
    }
    case "chat": {
      const player = pickPlayer(ctx, goal);
      if (!player) return { state: "pending", detail: "no client player" };
      const lines = ctx.chat.get(player) ?? [];
      const needles = Array.isArray(goal.contains) ? goal.contains : [goal.contains];
      const hit = needles.every((n) => lines.some((l) => l.includes(n)));
      return observed(hit, `chat match for ${needles.join(", ")}`);
    }
    case "completion": {
      const name = pickPlayer(ctx, goal);
      if (!name) return { state: "pending", detail: "no client player" };
      const completion = ctx.completions.get(name);
      if (!completion) return { state: "pending", detail: `${name} has not reported completion` };
      const suffix = completion.detail ? `: ${completion.detail}` : "";
      return completion.status === "succeeded"
        ? { state: "passed", detail: `${name} completed${suffix}` }
        : { state: "failed", detail: `${name} failed${suffix}` };
    }
    case "survive": {
      const secs = goal.seconds;
      const elapsed = (Date.now() - ctx.startedAt) / 1000;
      const players = goal.who === undefined ? ctx.players : [goal.who];
      const deaths = await Promise.all(players.map((name) => ctx.observer.playerDeaths(name)));
      const alive = deaths.every((count) => count === 0);
      return observed(alive && elapsed >= secs, `alive ${elapsed.toFixed(0)}/${secs}s`);
    }
    case "all":
    case "any": {
      const children = await Promise.all(goal.goals.map((child) => evaluateGoal(child, ctx)));
      const passed = goal.kind === "all"
        ? children.every((child) => child.state === "passed")
        : children.some((child) => child.state === "passed");
      const failed = goal.kind === "all"
        ? children.some((child) => child.state === "failed")
        : children.every((child) => child.state === "failed");
      const detail = passed
        ? `${goal.kind}(${children.length}) passed`
        : failed
          ? `${goal.kind} failed: ${children.find((child) => child.state === "failed")?.detail ?? "terminal child"}`
          : `${goal.kind} pending: ${children
              .filter((child) => child.state === "pending")
              .slice(0, 2)
              .map((child) => child.detail)
              .join("; ")}`;
      return {
        state: passed ? "passed" : failed ? "failed" : "pending",
        detail,
        children,
      };
    }
  }
}

/** Flat, human-readable rendering of a goal tree for reports. */
export function describeGoal(goal: GoalCondition, indent = 0): string {
  const pad = "  ".repeat(indent);
  const base = (() => {
    switch (goal.kind) {
      case "reach":
        return `reach ${posToCommand(goal.pos)}${goal.radius ? ` (r=${goal.radius})` : ""}`;
      case "kill":
        return `kill all ${goal.target}`;
      case "entityCount":
        return `count ${goal.entity} ∈ [${goal.min ?? 0}, ${goal.max ?? "∞"}]`;
      case "entityDistance":
        return `distance from every ${goal.entity} > ${goal.distance}`;
      case "hasItem":
        return `have ${goal.count ?? 1}× ${goal.item}`;
      case "blockAt":
        return `${goal.block} at ${goal.pos.join(",")}`;
      case "blocksAt": {
        const positions = goal.positions.map(pos => pos.join(",")).join("; ");
        return `${goal.block} at all ${goal.positions.length} positions: ${positions}`;
      }
      case "health":
        return `health ≥ ${goal.health ?? 1}`;
      case "chat":
        return `chat contains ${JSON.stringify(goal.contains)}`;
      case "completion":
        return `${goal.who ?? "first player"} reports successful completion`;
      case "survive":
        return `survive ${goal.seconds}s`;
      case "all":
        return "ALL of:";
      case "any":
        return "ANY of:";
    }
  })();
  const children = (goal.kind === "all" || goal.kind === "any")
    ? goal.goals.map((child) => describeGoal(child, indent + 1)).join("\n")
    : "";
  return pad + base + (children ? `\n${children}` : "");
}
