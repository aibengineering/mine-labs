import assert from "node:assert/strict";
import test from "node:test";
import { scenarioSchema } from "./schema.js";
import { inspectScenario } from "./inspection.js";

test("inspection preserves nested logic, player scope, explicit zero radius, defaults and driver-owned conditions", () => {
  const scenario = scenarioSchema.parse({
    tags:["regression"], description:"Protect the historical failure.",
    players: [{name:"FirstBot"},{name:"OtherBot",inventory:[{item:"cobblestone",count:64}]}],
    client:{command:"bun",env:{PRIVATE_TOKEN:"must-not-appear"}}, params:{startingHealth:7},
    goal:{kind:"all",timeout:60,goals:[
      {kind:"survive",seconds:20},
      {kind:"any",goals:[{kind:"hasItem",who:"OtherBot",item:"diamond"},{kind:"reach",pos:[1,2,3],radius:0}]},
      {kind:"completion",who:"OtherBot"},
    ]},
  });
  const inspection=inspectScenario("flat/combat/example",scenario);
  assert.deepEqual(inspection.tags,["regression"]);
  assert.equal(inspection.description,"Protect the historical failure.");
  scenario.tags.push("changed");
  assert.deepEqual(inspection.tags,["regression"],"inspection owns its labels");
  assert.equal(inspection.timeoutSeconds,60);
  assert.match(inspection.goal.label,/AND/);
  assert.match(inspection.goal.children![0]!.label,/All scenario players.*20 seconds.*zero recorded deaths/);
  assert.match(inspection.goal.children![1]!.label,/OR/);
  assert.match(inspection.goal.children![1]!.children![0]!.label,/OtherBot.*at least 1 x diamond/);
  assert.match(inspection.goal.children![1]!.children![1]!.label,/FirstBot.*within 0 blocks/);
  assert.match(inspection.goal.children![2]!.label,/OtherBot.*driver code/);
  assert.ok(inspection.parameters.join("\n").includes('"startingHealth": 7'));
  assert.ok(inspection.setup.find(section=>section.title==="Players")!.lines.some(line=>line.includes("64 x cobblestone")));
  assert.ok(!JSON.stringify(inspection).includes("must-not-appear"));
});

test("inspection lists each schedule entry with when it runs", () => {
  const scenario = scenarioSchema.parse({
    client: { command: "bun" }, goal: { kind: "completion" },
    schedule: [
      { afterTicks: 20, run: "say late" },
      { afterTicks: 5, when: "entity @a[name=Bot,x=2,y=-61,z=-5,dx=4,dy=4,dz=4]", run: ["say a", "say b"] },
    ],
  });
  assert.deepEqual(inspectScenario("scheduled", scenario).setup.find(section => section.title === "schedule commands")?.lines, [
    "Once 20 ticks after start:", "  say late",
    "Once 5 ticks after start, then when entity @a[name=Bot,x=2,y=-61,z=-5,dx=4,dy=4,dz=4]:", "  say a", "  say b",
  ]);
});

test("inspection shows declared starting health and hunger", () => {
  const scenario = scenarioSchema.parse({
    client: { command: "bun" }, goal: { kind: "completion" },
    players: [{ name: "Hungry", food: 6 }, { name: "Wounded", health: 9 }, { name: "Plain" }],
  });
  const players = inspectScenario("vitals", scenario).setup.find(section => section.title === "Players")!.lines;
  assert.ok(players.includes("Health: 20 | Food: 6 | Saturation: 0"), players.join("\n"));
  assert.ok(players.includes("Health: 9"), players.join("\n"));
  assert.equal(players.filter(line => line.startsWith("Health:")).length, 2);
});

test("inspection names an entity goal's scope", () => {
  const scenario = scenarioSchema.parse({
    client: { command: "bun" },
    goal: { kind: "all", goals: [
      { kind: "kill", target: "zombie", tag: "penA" },
      { kind: "entityCount", entity: "pig", max: 0, near: { pos: [1, 2, 3], radius: 5 } },
    ] },
  });
  assert.deepEqual(inspectScenario("scoped", scenario).goal.children?.map(child => child.label), [
    "No zombie tagged penA remaining; at least one must have been observed",
    "pig within 5 blocks of 1 2 3: count between 0 and 0",
  ]);
});

test("inspection reads a bounded hasItem as a range", () => {
  const scenario = scenarioSchema.parse({
    client: { command: "bun" }, players: [{ name: "Archer" }],
    goal: { kind: "all", goals: [
      { kind: "hasItem", item: "arrow", count: 0, max: 0 },
      { kind: "hasItem", item: "bone", count: 3, max: 3 },
      { kind: "hasItem", item: "bread", count: 1, max: 4 },
    ] },
  });
  assert.deepEqual(inspectScenario("bounded", scenario).goal.children?.map(child => child.label), [
    "Archer: carry no arrow", "Archer: carry exactly 3 x bone", "Archer: carry between 1 and 4 x bread",
  ]);
});
