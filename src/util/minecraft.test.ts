import assert from "node:assert/strict";
import test from "node:test";
import { commandVerb, inDimension, itemId, itemStack, withoutDimension } from "./minecraft.js";


test("the overworld stays bare and other dimensions are scoped with execute in", () => {
  assert.equal(inDimension("overworld", "fill 0 0 0 1 1 1 air"), "fill 0 0 0 1 1 1 air");
  assert.equal(inDimension("the_nether", "fill 0 0 0 1 1 1 air"), "execute in minecraft:the_nether run fill 0 0 0 1 1 1 air");
  assert.equal(inDimension("minecraft:the_end", "/setblock 0 60 0 stone"), "execute in minecraft:the_end run setblock 0 60 0 stone");
  // An existing execute chain gets the dimension spliced in rather than a second execute in front.
  assert.equal(
    inDimension("the_nether", "execute as @a run tp @s 0 70 0"),
    "execute in minecraft:the_nether as @a run tp @s 0 70 0",
  );
});

test("a scoped command reads back as the command it wrapped", () => {
  assert.equal(withoutDimension("execute in minecraft:the_nether run fill 0 0 0 1 1 1 air"), "fill 0 0 0 1 1 1 air");
  assert.equal(withoutDimension("execute in minecraft:the_nether as @a run tp @s 0 70 0"), "execute as @a run tp @s 0 70 0");
  assert.equal(withoutDimension("/fill 0 0 0 1 1 1 air"), "fill 0 0 0 1 1 1 air");
  assert.equal(commandVerb("execute in minecraft:the_end run summon minecraft:blaze 0 60 0"), "summon");
  assert.equal(commandVerb("gamerule doMobSpawning false"), "gamerule");
});

test("an item stack keeps its components and qualifies only its id", () => {
  assert.equal(itemStack("diamond_pickaxe"), "minecraft:diamond_pickaxe");
  assert.equal(itemStack("diamond_pickaxe[damage=1556]"), "minecraft:diamond_pickaxe[damage=1556]");
  assert.equal(itemStack("shield[minecraft:damage=335]"), "minecraft:shield[minecraft:damage=335]");
  assert.equal(itemStack("mymod:wand[custom_name='\"a:b\"']"), "mymod:wand[custom_name='\"a:b\"']");
  // An observation compares the base id: the game reports components separately.
  assert.equal(itemId("shield[minecraft:damage=335]"), "minecraft:shield");
  assert.equal(itemId("minecraft:bread"), "minecraft:bread");
});
