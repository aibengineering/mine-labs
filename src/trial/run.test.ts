import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ClientCompletion } from "../client/protocol.js";
import { awaitScenarioGoal, runScenarioTrial } from "./run.js";
import { scenarioSchema } from "../scenario/schema.js";

const scenario = scenarioSchema.parse({
  name: "settlement",
  minecraft: { version: "1.21.4" },
  world: { type: "flat" },
  players: [{ name: "Collector" }],
  client: { command: "true", args: [] },
  goal: {
    kind: "all",
    timeout: 5,
    goals: [
      { kind: "hasItem", who: "Collector", item: "coal", count: 1 },
      { kind: "completion", who: "Collector" },
    ],
  },
});

test("a completion reported while the goal is being read still settles the trial", async () => {
  const completions = new Map<string, ClientCompletion>();
  // The completion child reads this map synchronously; its sibling waits on
  // rcon. A client that finishes inside that window is invisible to the read
  // that is already in flight, which is exactly the interleaving that reported
  // a physically successful run as "has not reported completion".
  const observer = {
    countEntities: async () => 0,
    playerWithin: async () => true,
    playerFarFromEntities: async () => true,
    countPlayerItems: async () => {
      // Yield first, so the completion child has already read the empty map by
      // the time the report lands — the ordering rcon latency produces for real.
      await Promise.resolve();
      completions.set("Collector", {
        status: "succeeded",
        detail: "action completed",
      });
      return 1;
    },
    blockMatches: async () => true,
    playerHealth: async () => 20,
    playerDeaths: async () => 0,
  };

  const settlement = await awaitScenarioGoal({
    scenario,
    server: { rcon: observer } as unknown as Parameters<
      typeof awaitScenarioGoal
    >[0]["server"],
    clients: { processes: new Map(), chat: new Map(), completions },
  });

  assert.equal(settlement.outcome, "pass");
  assert.equal(settlement.goal.state, "passed");
});

test("a failed snapshot never arranges or tears down an unsaved arena", async () => {
  const commands: string[] = [];
  const fixture = scenarioSchema.parse({
    name: "snapshot-failure", players: [{ name: "Builder", pos: [0.5, -60, 0.5] }],
    reset: ["fill 0 -60 0 5 -60 5 air"],
    client: { command: "must-not-start" }, goal: { kind: "completion", who: "Builder" },
  });
  const server = {
    operatorNames: [],
    rcon: {
      command: async (command: string) => { commands.push(command); return ""; },
      executeChecked: async (command: string) => {
        commands.push(command);
        if (command.startsWith("clone ")) throw new Error("snapshot refused");
      },
    },
  } as unknown as Parameters<typeof runScenarioTrial>[0]["server"];
  const result = await runScenarioTrial({ runDir: "unused-snapshot-failure", scenario: fixture, server, reuseServer: true, log: () => {} });
  assert.equal(result.outcome, "error");
  assert.equal(result.error, "snapshot refused");
  assert.ok(commands.some((command) => command.startsWith("clone ")));
  assert.equal(commands.at(-1), "forceload remove all");
  assert.ok(!commands.some((command) => /^(fill|kill|reload)(?: |$)/u.test(command)));
});

test("a prepared world is frozen before setup and cancellation never launches its clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-frozen-world-"));
  const commands: string[] = [];
  const cancellation = new AbortController();
  const prepared = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const fixture = scenarioSchema.parse({
    name: "frozen", players: [{ name: "Tester", pos: [0, -60, 0] }],
    geometry: [{ setblock: { at: [1, -58, 1], block: "sand" } }],
    tick: ["say started"], client: { command: "must-not-launch" }, goal: { kind: "completion" },
  });
  const server = {
    worldDir: join(root, "world"), operatorNames: [], gamePort: 12345,
    rcon: {
      command: async (command: string) => { commands.push(command); return ""; },
      executeChecked: async (command: string) => { commands.push(command); return ""; },
    },
  } as unknown as Parameters<typeof runScenarioTrial>[0]["server"];
  try {
    const trial = runScenarioTrial({ runDir: root, scenario: fixture, server, log: () => {}, signal: cancellation.signal,
      holdPreparedWorld: true, onWorldPrepared: () => { prepared.resolve(); return gate.promise; },
    });
    await prepared.promise;
    assert.ok(commands.indexOf("tick freeze") < commands.indexOf("setblock 1 -58 1 sand"));
    assert.equal(await readFile(join(server.worldDir, "datapacks", "mine_labs_scenario", "data", "mine_labs_scenario", "function", "tick.mcfunction"), "utf8"), "\n");
    cancellation.abort("menu");
    assert.equal((await trial).outcome, "cancelled");
    assert.ok(!commands.includes("tick unfreeze"));
    assert.equal(commands.at(-1), "forceload remove all");
  } finally {
    cancellation.abort();
    gate.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test("world and client gates precede observer arrival, activation, and thaw", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-frozen-start-"));
  const commands: string[] = [];
  const fixture = scenarioSchema.parse({
    name: "frozen-start", players: [{ name: "Tester" }], tick: ["say started"],
    entities: [{ type: "zombie", pos: [0, -60, 0] }],
    client: { command: "bun", args: [resolve("src/client/test-fixtures/protocol-client.mjs")] }, goal: { kind: "completion" },
  });
  const server = {
    worldDir: join(root, "world"), operatorNames: [], gamePort: 12345,
    rcon: {
      command: async (command: string) => { commands.push(command); return ""; },
      executeChecked: async (command: string) => { commands.push(command); return ""; },
      playerOnline: async (name: string) => { commands.push(`online ${name}`); return true; },
      preparePlayerMetrics: async () => {},
    },
  } as unknown as Parameters<typeof runScenarioTrial>[0]["server"];
  try {
    const result = await runScenarioTrial({ runDir: root, scenario: fixture, server, log: () => {},
      holdPreparedWorld: true, waitForSpectator: true, spectatorUsername: "Observer",
      onWorldPrepared: async () => { commands.push("world prepared"); },
      onPrepared: async () => { commands.push("clients prepared"); },
      onStarted: async () => { commands.push("starting"); },
    });
    assert.equal(result.outcome, "pass", result.error);
    const order = ["tick freeze", "world prepared", "online Tester", "clients prepared", "online Observer", "summon minecraft:zombie 0 -60 0", "starting", "tick unfreeze"];
    for (let index = 1; index < order.length; index++) {
      assert.ok(commands.indexOf(order[index - 1]!) >= 0, order[index - 1]);
      assert.ok(commands.indexOf(order[index - 1]!) < commands.indexOf(order[index]!), JSON.stringify(commands));
    }
    assert.equal(await readFile(join(server.worldDir, "datapacks", "mine_labs_scenario", "data", "mine_labs_scenario", "function", "tick.mcfunction"), "utf8"), "say started\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
