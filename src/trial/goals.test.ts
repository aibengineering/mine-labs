import assert from "node:assert/strict";
import test from "node:test";
import type { ClientCompletion } from "../client/protocol.js";
import { evaluateGoal, observeInitialGoalState, type GoalContext, type GoalObserver } from "./goals.js";
import { scenarioSchema } from "../scenario/schema.js";

function context(
  completions: ReadonlyMap<string, ClientCompletion>,
  observer: GoalObserver = passingObserver,
  state = new Map(),
): GoalContext {
  return {
    players: ["Collector", "Helper"],
    dimension: "overworld",
    observer,
    chat: new Map(),
    completions,
    startedAt: Date.now(),
    state,
  };
}

test("kill goals retain a real pre-start entity observation", async () => {
  const goal = { kind: "kill" as const, target: "zombie" };
  let count = 1;
  const observer: GoalObserver = {
    ...passingObserver,
    countEntities: async () => count,
  };

  const state = await observeInitialGoalState(goal, observer);
  count = 0;

  assert.equal((await evaluateGoal(goal, context(new Map(), observer, state))).state, "passed");
});

const passingObserver: GoalObserver = {
  countEntities: async () => 0,
  playerWithin: async () => true,
  playerFarFromEntities: async () => true,
  countPlayerItems: async () => 1,
  blockMatches: async () => true,
  playerHealth: async () => 20,
  playerDeaths: async () => 0,
};

test("blocksAt checks every position in the scenario dimension and identifies mismatches", async () => {
  const positions: [number, number, number][] = [[3, 64, -8], [-10, 12, 4], [5, 90, 20]];
  const goal = { kind: "blocksAt" as const, block: "minecraft:STONE", positions };
  const checked: number[][] = [];
  let wrongPosition: string | undefined;
  const observer: GoalObserver = {
    ...passingObserver,
    blockMatches: async (pos, block, dimension) => {
      assert.equal(block, "stone");
      assert.equal(dimension, "the_nether");
      checked.push([...pos]);
      return pos.join(",") !== wrongPosition;
    },
  };
  const ctx: GoalContext = { ...context(new Map(), observer), dimension: "the_nether" };
  assert.equal((await evaluateGoal(goal, ctx)).state, "passed");
  assert.deepEqual(checked, positions);
  for (const pos of positions) {
    checked.length = 0;
    wrongPosition = pos.join(",");
    const result = await evaluateGoal(goal, ctx);
    assert.equal(result.state, "pending");
    assert.equal(result.detail, `stone: 2/3 positions match; wrong at ${wrongPosition}`);
    assert.deepEqual(checked, positions);
  }
});

test("block goals share integer cell coordinates while reach accepts fractional positions", () => {
  const parse = (goal: unknown) => scenarioSchema.safeParse({ client: { command: "test" }, goal });
  for (const kind of ["blockAt", "blocksAt"] as const) {
    const goalAt = (pos: number[]) => ({
      kind, block: "stone", ...(kind === "blockAt" ? { pos } : { positions: [pos] }),
    });
    assert.ok(parse(goalAt([-3, 60, 0])).success);
    for (const pos of [[0.5, 60, 0], [0, 60.5, 0], [0, 60, 0.5], [0, 60], [Number.MAX_SAFE_INTEGER + 1, 60, 0]]) {
      assert.equal(parse(goalAt(pos)).success, false);
    }
  }
  assert.ok(parse({ kind: "reach", pos: [0.5, 60, 0.5] }).success);
});

test("blocksAt requires a block and a nonempty position list, including within composite goals", () => {
  const parse = (goal: unknown) => scenarioSchema.safeParse({ client: { command: "test" }, goal });
  const valid = { kind: "blocksAt", block: "air", positions: [[0, 60, 0]] };
  assert.ok(parse(valid).success);
  assert.ok(parse({ kind: "all", goals: [valid] }).success);
  for (const goal of [
    { kind: "blocksAt", positions: [[0, 60, 0]] },
    { ...valid, block: "" },
    { ...valid, positions: [] },
  ]) {
    assert.equal(parse(goal).success, false);
    assert.equal(parse({ kind: "all", goals: [goal] }).success, false);
  }
});

test("completion goals distinguish pending, passed, and terminal failure", async () => {
  const goal = { kind: "completion" as const, who: "Collector" };

  assert.equal((await evaluateGoal(goal, context(new Map()))).state, "pending");
  assert.equal(
    (await evaluateGoal(goal, context(new Map([["Collector", { status: "succeeded" }]])))).state,
    "passed",
  );
  assert.equal(
    (
      await evaluateGoal(
        goal,
        context(new Map([["Collector", { status: "failed", detail: "action returned partial" }]])),
      )
    ).state,
    "failed",
  );
});

test("terminal completion failure propagates through an all goal", async () => {
  const result = await evaluateGoal(
    {
      kind: "all",
      goals: [
        { kind: "completion", who: "Collector" },
        { kind: "completion", who: "Helper" },
      ],
    },
    context(
      new Map([
        ["Collector", { status: "failed", detail: "could not finish" }],
        ["Helper", { status: "succeeded" }],
      ]),
    ),
  );

  assert.equal(result.state, "failed");
  assert.match(result.detail, /could not finish/u);
});

test("scenario schema accepts completion goals", () => {
  const scenario = scenarioSchema.parse({
    client: { command: "test-client" },
    players: [{ name: "Collector" }],
    goal: { kind: "completion", who: "Collector", timeout: 10 },
  });

  assert.equal(scenario.goal.kind, "completion");
});

test("goal schemas reject incomplete block observations", () => {
  const result = scenarioSchema.safeParse({
    client: { command: "test-client" },
    players: [{ name: "Collector" }],
    goal: { kind: "blockAt" },
  });

  assert.equal(result.success, false);
});

test("scenario schemas reject impossible entity ranges", () => {
  const result = scenarioSchema.safeParse({
    client: { command: "test-client" },
    players: [{ name: "Collector" }],
    goal: { kind: "entityCount", entity: "zombie", min: 5, max: 2 },
  });

  assert.equal(result.success, false);
  if (!result.success) assert.match(result.error.message, /minimum cannot exceed maximum/u);
});

test("scenario schemas reject unknown players in nested goals", () => {
  const result = scenarioSchema.safeParse({
    client: { command: "test-client" },
    players: [{ name: "Collector" }],
    goal: {
      kind: "all",
      goals: [
        { kind: "hasItem", who: "Collector", item: "sand" },
        { kind: "completion", who: "Collectro" },
      ],
    },
  });

  assert.equal(result.success, false);
  if (!result.success) assert.match(result.error.message, /unknown player 'Collectro'/u);
});

test("client-independent goals use server observations", async () => {
  const calls: string[] = [];
  const observer: GoalObserver = {
    ...passingObserver,
    playerWithin: async (name, pos, radius) => {
      calls.push(`${name}:${pos.join(",")}:${radius}`);
      return true;
    },
    playerFarFromEntities: async (name, entity, distance) => {
      calls.push(`${name}:${entity}:${distance}`);
      return true;
    },
    countPlayerItems: async (name, item) => {
      calls.push(`${name}:${item}`);
      return 3;
    },
  };

  const result = await evaluateGoal(
    {
      kind: "all",
      goals: [
        { kind: "reach", who: "Collector", pos: [4, -59, 2], radius: 1.5 },
        { kind: "entityDistance", who: "Collector", entity: "zombie", distance: 36 },
        { kind: "hasItem", who: "Collector", item: "diamond", count: 2 },
      ],
    },
    context(new Map(), observer),
  );

  assert.equal(result.state, "passed");
  assert.deepEqual(calls, ["Collector:4,-59,2:1.5", "Collector:zombie:36", "Collector:diamond"]);
});

test("a survive goal with who observes only that declared player", async () => {
  const observedPlayers: string[] = [];
  const observer: GoalObserver = {
    ...passingObserver,
    playerDeaths: async (name) => {
      observedPlayers.push(name);
      return name === "Helper" ? 1 : 0;
    },
  };
  const goalContext = context(new Map(), observer);
  goalContext.startedAt = Date.now() - 2_000;

  const result = await evaluateGoal(
    { kind: "survive", who: "Collector", seconds: 1 },
    goalContext,
  );

  assert.equal(result.state, "passed");
  assert.deepEqual(observedPlayers, ["Collector"]);
});
