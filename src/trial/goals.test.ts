import assert from "node:assert/strict";
import test from "node:test";
import type { ClientCompletion } from "../client/protocol.js";
import { describeGoal, evaluateGoal, observeInitialGoalState, type GoalContext, type GoalObserver } from "./goals.js";
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

test("kill and entityCount count only the entities their tag and near scope name", async () => {
  const calls: unknown[] = [];
  let counts = [1, 0, 2];
  const observer: GoalObserver = {
    ...passingObserver,
    countEntities: async (type, scope, dimension) => { calls.push([type, scope, dimension]); return counts.shift() ?? 0; },
  };
  const parsed = scenarioSchema.parse({
    client: { command: "test-client" }, world: { dimension: "the_nether" },
    players: [{ name: "Collector", pos: [0, 70, 0] }],
    goal: { kind: "all", goals: [
      { kind: "kill", target: "zombie", tag: "penA" },
      { kind: "entityCount", entity: "pig", near: { pos: [2, -60, 3], radius: 4 }, tag: "penB", min: 2 },
    ] },
  });
  const goal = parsed.goal;
  assert.ok(goal.kind === "all");
  const state = await observeInitialGoalState(goal, observer, undefined, "the_nether");
  const goalContext = { ...context(new Map(), observer, state), dimension: "the_nether" as const };
  const result = await evaluateGoal(goal, goalContext);
  assert.equal(result.state, "passed");
  assert.deepEqual(result.children?.map((child) => child.detail), [
    "zombie tagged penA remaining: 0",
    "pig tagged penB within 4 blocks of 2 -60 3 count: 2 (want 2..∞)",
  ]);
  assert.deepEqual(calls, [
    ["zombie", { tag: "penA" }, "the_nether"],
    ["zombie", { tag: "penA" }, "the_nether"],
    ["pig", { tag: "penB", near: { pos: [2, -60, 3], radius: 4 } }, "the_nether"],
  ]);
  assert.equal(describeGoal(goal), [
    "ALL of:",
    "  kill all zombie tagged penA",
    "  count pig tagged penB within 4 blocks of 2 -60 3 ∈ [2, ∞]",
  ].join("\n"));
  // Unscoped goals are unchanged.
  counts = [3];
  assert.equal((await evaluateGoal({ kind: "entityCount", entity: "cow", max: 3 }, context(new Map(), observer))).detail, "cow count: 3 (want 0..3)");
  assert.deepEqual(calls.at(-1), ["cow", {}, "overworld"]);
});

test("an entity scope names a scoreboard tag and a point with a radius, nothing else", () => {
  const goal = (fields: Record<string, unknown>) => scenarioSchema.safeParse({
    client: { command: "test-client" }, goal: { kind: "kill", target: "zombie", ...fields },
  }).success;
  assert.equal(goal({ tag: "pen.A-1+x_" }), true);
  assert.equal(goal({ tag: "two words" }), false);
  assert.equal(goal({ tag: "" }), false);
  assert.equal(goal({ near: { pos: [0.5, -60, 0.5], radius: 0 } }), true);
  assert.equal(goal({ near: { pos: [0, 0, 0] } }), false);
  assert.equal(goal({ near: { pos: [0, 0, 0], radius: -1 } }), false);
  assert.equal(goal({ near: { pos: "~ ~ ~", radius: 2 } }), false);
  assert.equal(goal({ near: { pos: [0, 0, 0], radius: 2, dimension: "the_end" } }), false);
});
