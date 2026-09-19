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
