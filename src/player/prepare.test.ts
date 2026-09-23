import assert from "node:assert/strict";
import test from "node:test";
import { preparePlayerForTrial, type PlayerCommandHost } from "./prepare.js";

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
  readonly tags = new Set<string>();
  readonly inventory: string[] = [];
  /** Queued answers to `data get entity <name> Fire`; a settled body answers -20s. */
  readonly fire: string[] = [];

  async command(command: string): Promise<string> {
    this.commands.push(command);
    const fire = /^data get entity (\S+) Fire$/u.exec(command);
    if (fire) return this.fire.shift() ?? `${fire[1]} has the following entity data: -20s`;
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
  await preparePlayerForTrial({
    commands: host,
    player: { name: "Wounded", pos: [192.5, 49, -19.5], inventory: [], op: false, health: 11 },
    dimension: "the_nether",
    resetReusablePlayer: false,
  });
  assert.deepEqual(host.commands, [
    "damage Wounded 9 minecraft:magic",
    "execute in minecraft:the_nether run tp Wounded 192.5 49 -19.5",
  ]);
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
  });
  const teleport = host.commands.indexOf("execute in minecraft:the_nether run tp Wounded 192.5 49 -19.5");
  const found = host.commands.lastIndexOf("data get entity Wounded Fire");
  const survival = host.commands.indexOf("gamemode survival Wounded");
  const restore = host.commands.indexOf("effect give Wounded minecraft:instant_health 1 9 true");
  const wound = host.commands.indexOf("damage Wounded 9 minecraft:magic");
  assert.equal(host.commands.filter(command => command === "data get entity Wounded Fire").length, 3);
  assert.ok(teleport >= 0 && found > teleport && survival > found && restore > survival && wound > restore,
    host.commands.join("\n"));
});

test("a reused body that rejoined burning stays a spectator until its fire is out", async () => {
  const host = new FakePlayerHost();
  host.fire.push("Collector has the following entity data: 294s", "Collector has the following entity data: 120s");
  await preparePlayerForTrial({
    commands: host,
    player: { name: "Collector", pos: [0, -59, 0], inventory: [], op: false },
    resetReusablePlayer: true,
  });
  const reads = host.commands.flatMap((command, index) => command === "data get entity Collector Fire" ? [index] : []);
  assert.equal(reads.length, 3);
  assert.ok(host.commands.indexOf("gamemode survival Collector") > reads.at(-1)!);
});

test("a reused body that never stops burning fails preparation instead of starting the trial", { timeout: 10_000 }, async () => {
  const host = new FakePlayerHost();
  host.fire.push(...Array.from({ length: 100 }, () => "Collector has the following entity data: 300s"));
  await assert.rejects(
    preparePlayerForTrial({
      commands: host,
      player: { name: "Collector", pos: [0, -59, 0], inventory: [], op: false },
      resetReusablePlayer: true,
    }),
    /Collector could not return to survival/u,
  );
  assert.ok(!host.commands.includes("gamemode survival Collector"));
});
