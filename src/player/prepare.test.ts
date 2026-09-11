import assert from "node:assert/strict";
import test from "node:test";
import { preparePlayerForTrial, type PlayerCommandHost } from "./prepare.js";

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

  assert.deepEqual(host.commands.slice(0, 11), [
    "clear Collector",
    "effect clear Collector",
    "gamemode survival Collector",
    // Operator rights are granted per trial, so a reused player must not keep
    // them from the last one.
    "deop Collector",
    "tag Collector list",
    "tag Collector remove collection_equipped",
    "give Collector minecraft:iron_pickaxe 1",
    // A reused player keeps its body across trials: lava fire is entity NBT
    // that `effect clear` cannot touch, and lost health never regenerates on
    // no-regeneration fixtures. Directly reset Fire so no water leaks into
    // the reused world.
    "effect give Collector minecraft:instant_health 1 9 true",
    "effect give Collector minecraft:saturation 1 9 true",
    "data merge entity Collector {Fire:0s}",
    "tp Collector 0 -59 0",
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

  async command(command: string): Promise<string> {
    this.commands.push(command);
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

test("a declared starting health is applied after a reused body's vitals are restored and before it leaves the overworld", async () => {
  const host = new FakePlayerHost();
  await preparePlayerForTrial({
    commands: host,
    player: { name: "Wounded", pos: [192.5, 49, -19.5], inventory: [], op: false, health: 11 },
    dimension: "the_nether",
    resetReusablePlayer: true,
  });
  const restore = host.commands.indexOf("effect give Wounded minecraft:instant_health 1 9 true");
  const wound = host.commands.indexOf("damage Wounded 9 minecraft:magic");
  const teleport = host.commands.indexOf("execute in minecraft:the_nether run tp Wounded 192.5 49 -19.5");
  assert.ok(restore >= 0 && wound > restore && teleport > wound, host.commands.join("\n"));
});
