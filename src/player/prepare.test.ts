import assert from "node:assert/strict";
import test from "node:test";
import { nextHungerMove, preparePlayerForTrial, type PlayerCommandHost } from "./prepare.js";

test("equipment follows reusable cleanup and precedes inventory grants and teleport", async () => {
  const host = new FakePlayerHost();
  await preparePlayerForTrial({ commands: host, resetReusablePlayer: true,
    player: { name: "Collector", pos: [0, -59, 0], op: false,
      inventory: [{ item: "gold_ingot", count: 3 }],
      equipment: { head: "golden_helmet", chest: "iron_chestplate", legs: "iron_leggings",
        feet: "iron_boots", mainhand: "iron_sword", offhand: "shield" },
    },
  });
  const equipment = host.commands.filter(command => command.startsWith("item replace"));
  assert.deepEqual(equipment, [
    "item replace entity Collector armor.head with minecraft:golden_helmet 1",
    "item replace entity Collector armor.chest with minecraft:iron_chestplate 1",
    "item replace entity Collector armor.legs with minecraft:iron_leggings 1",
    "item replace entity Collector armor.feet with minecraft:iron_boots 1",
    "item replace entity Collector weapon.mainhand with minecraft:iron_sword 1",
    "item replace entity Collector weapon.offhand with minecraft:shield 1",
  ]);
  const firstEquip = host.commands.indexOf(equipment[0]!);
  const lastEquip = host.commands.indexOf(equipment.at(-1)!);
  assert.ok(firstEquip > host.commands.indexOf("clear Collector"));
  assert.ok(lastEquip < host.commands.indexOf("give Collector minecraft:gold_ingot 3"));
  assert.ok(lastEquip < host.commands.indexOf("tp Collector 0 -59 0"));
});

test("reused trials remove unbracketed tags before restoring declared inventory", async () => {
  const host = new FakePlayerHost();
  const player = {
    name: "Collector",
    pos: [0, -59, 0] as [number, number, number],
    inventory: [{ item: "iron_pickaxe", count: 1 }],
    op: false,
  };

  for (let trial = 0; trial < 2; trial += 1) {
    host.tags.add("collection_equipped");
    host.inventory.push("stale_item");
    await preparePlayerForTrial({ commands: host, player, resetReusablePlayer: true });
    assert.deepEqual([...host.tags], []);
    assert.deepEqual(host.inventory, ["minecraft:iron_pickaxe"]);
  }

  assert.deepEqual(host.commands.slice(0, 12), [
    // A reused body may rejoin inside restored lava. As a spectator it takes
    // no damage there, and its fire goes out.
    "gamemode spectator Collector",
    "clear Collector",
    "effect clear Collector",
    // Operator rights are granted per trial, so a reused player must not keep
    // them from the last one.
    "deop Collector",
    "tag Collector list",
    "tag Collector remove collection_equipped",
    "give Collector minecraft:iron_pickaxe 1",
    "tp Collector 0 -59 0",
    // Survival only once the body is found at its position and not burning.
    "data get entity Collector Fire",
    "gamemode survival Collector",
    // Lost health never regenerates on no-regeneration fixtures.
    "effect give Collector minecraft:instant_health 1 9 true",
    "effect give Collector minecraft:saturation 1 9 true",
  ]);
});

test("non-reused trials leave player state alone", async () => {
  const host = new FakePlayerHost();
  await preparePlayerForTrial({
    commands: host,
    player: { name: "Scout", pos: [1, -60, 2] as [number, number, number], inventory: [], op: false },
    resetReusablePlayer: false,
  });

  assert.deepEqual(host.commands, ["tp Scout 1 -60 2"]);
});

class FakePlayerHost implements PlayerCommandHost {
  readonly commands: string[] = [];
  /** Each poll interval the preparation waited out, recorded instead of slept. */
  readonly waits: number[] = [];
  readonly wait = async (ms: number): Promise<void> => { this.waits.push(ms); };
  readonly tags = new Set<string>();
  readonly inventory: string[] = [];
  /** Queued answers to `data get entity <name> Fire`; a settled body answers -20s. */
  readonly fire: string[] = [];
  /** Queued answers to `damage`; a body past its join immunity answers that it was applied. */
  readonly damage: string[] = [];

  async command(command: string): Promise<string> {
    this.commands.push(command);
    const fire = /^data get entity (\S+) Fire$/u.exec(command);
    if (fire) return this.fire.shift() ?? `${fire[1]} has the following entity data: -20s`;
    if (/^data get entity \S+ active_effects$/u.test(command)) return "Found no elements matching active_effects";
    const damage = /^damage (\S+) (\d+) minecraft:magic$/u.exec(command);
    if (damage) return this.damage.shift() ?? `Applied ${damage[2]}.0 damage to ${damage[1]}`;
    if (command === "clear Collector") this.inventory.length = 0;
    else if (command === "tag Collector list") {
      return this.tags.size === 0
        ? "Collector has no tags"
        : `Collector has ${this.tags.size} tags: ${[...this.tags].join(", ")}`;
    } else if (command.startsWith("tag Collector remove ")) {
      this.tags.delete(command.slice("tag Collector remove ".length));
    } else if (command.startsWith("give Collector ")) {
      this.inventory.push(command.split(" ")[2]!);
    }
    return "ok";
  }
}

test("a player declared in the Nether is teleported there, since it joins in the overworld", async () => {
  const host = new FakePlayerHost();
  await preparePlayerForTrial({
    commands: host,
    player: { name: "Fighter", pos: [-27.5, 82, 355.5], inventory: [], op: true },
    dimension: "the_nether",
    resetReusablePlayer: false,
  });
  assert.deepEqual(host.commands, ["op Fighter", "execute in minecraft:the_nether run tp Fighter -27.5 82 355.5"]);
});

test("a declared starting health wounds a fresh body before it leaves the overworld", async () => {
  const host = new FakePlayerHost();
  // A player that has just joined is immune for a few seconds; vanilla refuses rather than fails.
  host.damage.push("Target is invulnerable to the given damage type", "Target is invulnerable to the given damage type");
  await preparePlayerForTrial({
    commands: host,
    player: { name: "Wounded", pos: [192.5, 49, -19.5], inventory: [], op: false, health: 11 },
    dimension: "the_nether",
    resetReusablePlayer: false,
    wait: host.wait,
  });
  assert.deepEqual(host.commands, [
    "data get entity Wounded active_effects",
    "damage Wounded 9 minecraft:magic",
    "damage Wounded 9 minecraft:magic",
    "damage Wounded 9 minecraft:magic",
    "execute in minecraft:the_nether run tp Wounded 192.5 49 -19.5",
  ]);
  assert.deepEqual(host.waits, [50, 50]);
});

test("a reused body is wounded only once it is found at its position, back in survival and restored", async () => {
  const host = new FakePlayerHost();
  // The first reads miss the player while it changes dimension.
  host.fire.push("No entity was found", "No entity was found");
  await preparePlayerForTrial({
    commands: host,
    player: { name: "Wounded", pos: [192.5, 49, -19.5], inventory: [], op: false, health: 11 },
    dimension: "the_nether",
    resetReusablePlayer: true,
    wait: host.wait,
  });
  const teleport = host.commands.indexOf("execute in minecraft:the_nether run tp Wounded 192.5 49 -19.5");
  const found = host.commands.lastIndexOf("data get entity Wounded Fire");
  const survival = host.commands.indexOf("gamemode survival Wounded");
  const restore = host.commands.indexOf("effect give Wounded minecraft:instant_health 1 9 true");
  // The restore is an effect that lands on the next tick; a wound dealt before it would be healed away.
  const landed = host.commands.indexOf("data get entity Wounded active_effects");
  const wound = host.commands.indexOf("damage Wounded 9 minecraft:magic");
  assert.equal(host.commands.filter(command => command === "data get entity Wounded Fire").length, 3);
  assert.ok(teleport >= 0 && found > teleport && survival > found && restore > survival && landed > restore && wound > landed,
    host.commands.join("\n"));
});

test("a reused body that rejoined burning stays a spectator until its fire is out", async () => {
  const host = new FakePlayerHost();
  host.fire.push("Collector has the following entity data: 294s", "Collector has the following entity data: 120s");
  await preparePlayerForTrial({
    commands: host,
    player: { name: "Collector", pos: [0, -59, 0], inventory: [], op: false },
    resetReusablePlayer: true,
    wait: host.wait,
  });
  const reads = host.commands.flatMap((command, index) => command === "data get entity Collector Fire" ? [index] : []);
  assert.equal(reads.length, 3);
  assert.equal(host.waits.length, 2);
  assert.ok(host.commands.indexOf("gamemode survival Collector") > reads.at(-1)!);
});

test("a reused body that never stops burning fails preparation instead of starting the trial", async () => {
  const host = new FakePlayerHost();
  host.fire.push(...Array.from({ length: 100 }, () => "Collector has the following entity data: 300s"));
  await assert.rejects(
    preparePlayerForTrial({
      commands: host,
      player: { name: "Collector", pos: [0, -59, 0], inventory: [], op: false },
      resetReusablePlayer: true,
      wait: host.wait,
    }),
    /Collector could not return to survival after 5000 ms/u,
  );
  assert.ok(!host.commands.includes("gamemode survival Collector"));
  // A hundred reads, fifty milliseconds apart: five seconds before giving up.
  assert.equal(host.waits.length, 99);
  assert.ok(host.waits.every((ms) => ms === 50));
});

test("each hunger step heads for the declared food level and saturation", () => {
  const cases: Array<[[number, number], [number, number], ReturnType<typeof nextHungerMove>]> = [
    [[20, 5], [20, 5], { kind: "done" }],
    // Saturation goes first, then food.
    [[20, 5], [6, 0], { kind: "drain" }],
    [[20, 20], [20, 5], { kind: "drain" }],
    // A raise lands on the food level with saturation to spare, then drains it.
    [[4, 0], [6, 0], { kind: "raise", food: 2 }],
    [[18, 10], [20, 5], { kind: "raise", food: 2 }],
    [[15, 0], [20, 10], { kind: "raise", food: 5 }],
    // Too little room to carry the saturation: drain further first.
    [[17, 0], [20, 10], { kind: "drain" }],
    [[20, 3], [20, 10], { kind: "drain" }],
    // An overshot drain steps back.
    [[5, 0], [6, 0], { kind: "raise", food: 1 }],
    [[20, 4.6000004], [20, 0], { kind: "drain" }],
  ];
  for (const [[food, saturation], [targetFood, targetSaturation], move] of cases) {
    assert.deepEqual(
      nextHungerMove({ food, saturation }, { food: targetFood, saturation: targetSaturation }), move,
      `${food}/${saturation} -> ${targetFood}/${targetSaturation}`,
    );
  }
});

/**
 * A body whose food bar behaves like vanilla's, one tick per wait: the hunger
 * effect takes a point per tick, saturation first; a saturation effect adds
 * its level in food and twice that in saturation, capped. Instant effects
 * land on the next tick, as they do in the game.
 */
class FakeHungryBody implements PlayerCommandHost {
  readonly commands: string[] = [];
  draining = false;
  /** Points a cleared drain still takes, as when a tick lands before the clear does. */
  overshoot = 0;
  /** Ticks of join immunity left, during which damage is refused. */
  immuneTicks = 0;
  private readonly pending: Array<() => void> = [];
  constructor(public food: number, public saturation: number, public health = 20, readonly drains = true) {}
  readonly wait = async (): Promise<void> => {
    for (const effect of this.pending.splice(0)) effect();
    if (this.immuneTicks > 0) this.immuneTicks -= 1;
    if (this.draining && this.drains) this.drainPoint();
  };
  private drainPoint(): void {
    if (this.saturation > 0) this.saturation = Math.max(this.saturation - 1, 0);
    else this.food = Math.max(this.food - 1, 0);
  }
  async command(command: string): Promise<string> {
    this.commands.push(command);
    const read = /^data get entity (\S+) (foodLevel|foodSaturationLevel|Health|Fire|active_effects)$/u.exec(command);
    if (read) {
      if (read[2] === "active_effects") {
        return this.pending.length || this.draining
          ? `${read[1]} has the following entity data: [{id: "minecraft:saturation"}]`
          : "Found no elements matching active_effects";
      }
      const value = { foodLevel: `${this.food}`, foodSaturationLevel: `${this.saturation}f`, Health: `${this.health}f`, Fire: "-20s" }[read[2]!];
      return `${read[1]} has the following entity data: ${value}`;
    }
    if (command.endsWith(" minecraft:hunger infinite 255 true")) this.draining = true;
    else if (command.endsWith(" minecraft:hunger")) {
      this.draining = false;
      for (; this.overshoot > 0; this.overshoot -= 1) this.drainPoint();
    }
    const raise = / minecraft:saturation 1 (\d+) true$/u.exec(command);
    if (raise) {
      const points = Number(raise[1]) + 1;
      this.pending.push(() => {
        this.food = Math.min(this.food + points, 20);
        this.saturation = Math.min(this.saturation + 2 * points, this.food);
      });
    }
    const heal = / minecraft:instant_health 1 (\d+) true$/u.exec(command);
    if (heal) this.pending.push(() => { this.health = Math.min(this.health + (4 << Number(heal[1])), 20); });
    const damage = /^damage (\S+) (\d+) minecraft:magic$/u.exec(command);
    if (damage) {
      if (this.immuneTicks > 0) return "Target is invulnerable to the given damage type";
      this.health -= Number(damage[2]);
      return `Applied ${damage[2]}.0 damage to ${damage[1]}`;
    }
    return "ok";
  }
}

test("a declared food level is drained to before the teleport, then resent with a brief wound", async () => {
  const body = new FakeHungryBody(20, 5);
  body.immuneTicks = 200;
  await preparePlayerForTrial({
    commands: body, wait: body.wait, resetReusablePlayer: false,
    player: { name: "Hungry", pos: [0.5, -60, 0.5], inventory: [], op: false, food: 6 },
  });
  assert.deepEqual([body.food, body.saturation, body.health], [6, 0, 20]);
  assert.equal(body.draining, false);
  const commands = body.commands.filter((command) => !command.startsWith("data get") && command !== "damage Hungry 1 minecraft:magic");
  assert.deepEqual(commands, [
    "effect give Hungry minecraft:hunger infinite 255 true",
    "effect clear Hungry minecraft:hunger",
    // Saturation alone does not reach the client; a change of health does,
    // once the joined body's immunity is over.
    "effect give Hungry minecraft:instant_health 1 0 true",
    "tp Hungry 0.5 -60 0.5",
  ]);
  assert.ok(body.commands.filter((command) => command === "damage Hungry 1 minecraft:magic").length > 1);
});

test("hunger is arranged once the restore has landed, at full health, and a declared wound is what sends it", async () => {
  const body = new FakeHungryBody(6, 0);
  await preparePlayerForTrial({
    commands: body, wait: body.wait, resetReusablePlayer: true,
    player: { name: "Hungry", pos: [0.5, -60, 0.5], inventory: [], op: false, health: 11, food: 15, saturation: 9 },
  });
  assert.deepEqual([body.food, body.saturation, body.health], [15, 9, 11]);
  const survival = body.commands.indexOf("gamemode survival Hungry");
  const drain = body.commands.indexOf("effect give Hungry minecraft:hunger infinite 255 true");
  const raise = body.commands.findIndex((command) => command.startsWith("effect give Hungry minecraft:saturation 1 4"));
  const wound = body.commands.indexOf("damage Hungry 9 minecraft:magic");
  assert.ok(survival < drain && drain < raise && raise < wound, body.commands.join("\n"));
  assert.equal(body.commands.filter((command) => command.startsWith("damage ")).length, 1);
});

test("a drain that overshoots while the effect is cleared steps back to the declared level", async () => {
  const body = new FakeHungryBody(20, 0);
  body.overshoot = 1;
  await preparePlayerForTrial({
    commands: body, wait: body.wait, resetReusablePlayer: false,
    player: { name: "Hungry", inventory: [], op: false, food: 10, saturation: 0 },
  });
  assert.deepEqual([body.food, body.saturation], [10, 0]);
  assert.ok(body.commands.includes("effect give Hungry minecraft:saturation 1 0 true"), body.commands.join("\n"));
});

test("a food bar that will not drain fails preparation and stops the drain", async () => {
  const body = new FakeHungryBody(20, 5, 20, false);
  await assert.rejects(
    preparePlayerForTrial({
      commands: body, wait: body.wait, resetReusablePlayer: false,
      player: { name: "Hungry", inventory: [], op: false, food: 6 },
    }),
    /Hungry did not reach food 6 and saturation 0 within 15000 ms \(at food 20, saturation 5\); food cannot drain on peaceful/u,
  );
  assert.equal(body.commands.at(-1), "effect clear Hungry minecraft:hunger");
});
