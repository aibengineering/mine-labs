import assert from "node:assert/strict";
import test from "node:test";
import { Rcon } from "./rcon.js";

test("server observations translate goals into RCON queries", async () => {
  const rcon = new FakeRcon([2, 1, 1, 1, 3, 1, 1750, 4]);

  assert.equal(await rcon.countEntities("zombie"), 2);
  assert.equal(await rcon.playerWithin("Runner", [4, -59, 2], 1.5), true);
  assert.equal(await rcon.playerFarFromEntities("Runner", "zombie", 36), true);
  assert.equal(await rcon.playerOnline("Runner"), true);
  assert.equal(await rcon.countPlayerItems("Runner", "diamond"), 3);
  assert.equal(await rcon.blockMatches([4, -60, 2], "stone"), true);
  assert.equal(await rcon.playerHealth("Runner"), 17.5);
  assert.equal(await rcon.playerDeaths("Runner"), 4);
  assert.ok(rcon.commands.includes('data modify storage mine_labs:query item_counts append from entity Runner Inventory[{id:"minecraft:diamond"}].count'));
  assert.ok(!rcon.commands.some((command) => /\bclear\b/u.test(command)), "inventory observation must not issue container mutations");
  assert.ok(rcon.commands.includes("execute store success score #ml_result ml_query run execute if block 4 -60 2 minecraft:stone"));
  assert.ok(rcon.commands.includes("execute store success score #ml_result ml_query run execute as Runner at @s positioned 4 -59 2 if entity @s[distance=..1.5]"));
  assert.ok(rcon.commands.includes("execute store success score #ml_result ml_query run execute at Runner unless entity @e[type=minecraft:zombie,distance=..36]"));
  assert.ok(rcon.commands.includes("execute store success score #ml_result ml_query run execute if entity @a[name=Runner]"));
});

test("reach checks use the named player's dimension and preserve a negative observation", async () => {
  const rcon = new FakeRcon([0]);

  assert.equal(await rcon.playerWithin("NetherRunner", [-240, 68, 176], 2), false);
  assert.ok(rcon.commands.includes(
    "execute store success score #ml_result ml_query run execute as NetherRunner at @s positioned -240 68 176 if entity @s[distance=..2]",
  ));
});

test("query objective initialization retries after a transient rejection", async () => {
  const rcon = new FlakyObjectivesRcon();

  await assert.rejects(rcon.countEntities("zombie"), /transient objective failure/u);
  assert.equal(await rcon.countEntities("zombie"), 0);
  assert.equal(rcon.objectiveAttempts, 2);
});

test("checked setup commands reject failed execution and permit an explicit harmless no-op", async () => {
  const success = new CheckedCommandRcon(1, "Filled 4 blocks");
  assert.equal(await success.executeChecked("fill 0 0 0 1 0 1 stone"), "Filled 4 blocks");

  const failure = new CheckedCommandRcon(0, "Incorrect argument for command");
  await assert.rejects(
    failure.executeChecked("fill broken"),
    /setup command failed: fill broken.*Incorrect argument/u,
  );

  const harmless = new CheckedCommandRcon(0, "No blocks were filled");
  assert.equal(
    await harmless.executeChecked("fill 0 0 0 1 0 1 air", { acceptedNoOp: /^No blocks were filled$/u }),
    "No blocks were filled",
  );
});

test("command() serializes concurrent calls, including ones nested inside another query, onto one connection", async () => {
  const rcon = new InstrumentedRcon();

  // `executeChecked` issues several nested `command()` calls of its own; racing
  // it against a plain external `command()` call reproduces the shape of the
  // real bug — arrangement's `forceload add` racing the operator-watch poll's
  // `gamemode`/`list` on the same socket. Before routing `command()` through
  // the query queue, `rawCommand` (standing in for the transport) could run
  // more than one at a time; now it never does.
  const [checked, listOutput] = await Promise.all([
    rcon.executeChecked("fill 0 0 0 1 0 1 stone"),
    rcon.command("list"),
  ]);

  assert.equal(checked, "Filled 4 blocks");
  assert.equal(listOutput, "ok");
  assert.equal(rcon.maxConcurrent, 1);
});

test("an external command arriving during an awaited query cannot bypass its queue", async () => {
  const rcon = new InstrumentedRcon();
  const checked = rcon.executeChecked("fill 0 0 0 1 0 1 stone");
  await new Promise((resolve) => setTimeout(resolve, 2));
  await Promise.all([checked, rcon.command("list")]);
  assert.equal(rcon.maxConcurrent, 1);
});

class InstrumentedRcon extends Rcon {
  maxConcurrent = 0;
  private concurrent = 0;

  constructor() {
    super("127.0.0.1", 0, "test");
  }

  protected override async rawCommand(cmd: string): Promise<string> {
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.concurrent--;
    if (cmd.startsWith("execute store success score #ml_command ml_query run ")) return "Filled 4 blocks";
    if (cmd === "scoreboard players get #ml_command ml_query") return "score holder has 1";
    return "ok";
  }
}

class FakeRcon extends Rcon {
  readonly commands: string[] = [];

  constructor(private readonly scores: number[]) {
    super("127.0.0.1", 0, "test");
  }

  override async command(command: string): Promise<string> {
    this.commands.push(command);
    if (command === "data get storage mine_labs:query item_counts") return `Storage mine_labs:query has the following contents: [${this.scores.shift() ?? 0}]`;
    if (!command.startsWith("scoreboard players get ")) return "ok";
    return `score holder has ${this.scores.shift() ?? 0}`;
  }
}

class FlakyObjectivesRcon extends Rcon {
  objectiveAttempts = 0;

  constructor() {
    super("127.0.0.1", 0, "test");
  }

  override async command(command: string): Promise<string> {
    if (command === "scoreboard objectives add ml_query dummy") {
      this.objectiveAttempts += 1;
      if (this.objectiveAttempts === 1) throw new Error("transient objective failure");
    }
    if (command.startsWith("scoreboard players get ")) return "score holder has 0";
    return "ok";
  }
}

class CheckedCommandRcon extends Rcon {
  constructor(private readonly success: number, private readonly response: string) {
    super("127.0.0.1", 0, "test");
  }

  override async command(command: string): Promise<string> {
    if (command.startsWith("execute store success score #ml_command ml_query run ")) return this.response;
    if (command === "scoreboard players get #ml_command ml_query") return `score holder has ${this.success}`;
    return "ok";
  }
}

test("inventory observations sum matching stacks and distinguish empty from malformed responses", async () => {
  class InventoryRcon extends Rcon {
    constructor(private readonly response: string) { super("127.0.0.1", 0, "test"); }
    override async command(command: string): Promise<string> {
      return command.startsWith("data get storage") ? this.response : "ok";
    }
  }
  assert.equal(await new InventoryRcon("Storage mine_labs:query has the following contents: [64, 9]").countPlayerItems("Runner", "oak_log"), 73);
  assert.equal(await new InventoryRcon("Storage mine_labs:query has the following contents: []").countPlayerItems("Runner", "oak_log"), 0);
  await assert.rejects(new InventoryRcon("No entity was found").countPlayerItems("Runner", "oak_log"), /did not return inventory counts/u);
  await assert.rejects(new InventoryRcon("Storage mine_labs:query has the following contents: [-1]").countPlayerItems("Runner", "oak_log"));
});

test("block observations are pointed at the scenario's dimension", async () => {
  const rcon = new FakeRcon([1]);
  assert.equal(await rcon.blockMatches([4, 82, 2], "nether_bricks", "the_nether"), true);
  assert.ok(rcon.commands.includes(
    "execute store success score #ml_result ml_query run execute in minecraft:the_nether if block 4 82 2 minecraft:nether_bricks",
  ));
});
