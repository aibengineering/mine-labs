/**
 * The scenario and client that `mine-labs init` writes into a new project.
 *
 * Their job is to be the fastest possible answer to "what does a scenario
 * actually look like": a complete, runnable pair a newcomer can execute
 * immediately and then edit, rather than documentation they have to assemble
 * into something that works. They live in source, not in a template directory,
 * so they cannot go missing from a published package.
 */

export const EXAMPLE_SCENARIO = `# mine-labs scenario
name: zombie-hunt
description: The client player must slay the zombie that spawns near it.

world:
  type: flat

geometry:
  - fill: { block: stone_bricks, from: [-4, -59, -4], to: [4, -59, 4], mode: replace }

entities:
  - type: zombie
    pos: [3, -59, 3]
    nbt: "{PersistenceRequired:1b}"

players:
  - name: hunter
    pos: [0, -59, 0]

client:
  command: bun
  args: ["../clients/hunter.js"]

goal:
  kind: kill
  target: zombie
  timeout: 90
`;

export const EXAMPLE_CLIENT = `// Hunter client: connects to the server Mine Labs hands it and kills the nearest zombie.
import { once } from "node:events";
import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { runNodeClient } from "mine-labs/client";
const { pathfinder, Movements, goals } = pathfinderPkg;

await runNodeClient(async (ctx) => {
  const bot = mineflayer.createBot({
    host: ctx.host,
    port: ctx.port,
    username: ctx.username,
    version: ctx.version,
    auth: "offline",
  });
  bot.loadPlugin(pathfinder);
  ctx.signal.addEventListener("abort", () => bot.quit(), { once: true });
  await once(bot, "spawn");
  ctx.ready();
  await ctx.arranged;
  ctx.prepared();
  await ctx.start;
  if (ctx.signal.aborted) return;

  bot.pathfinder.setMovements(new Movements(bot));
  ctx.log("hunter: scanning for zombies…");
  let target = null;
  const scan = setInterval(() => {
    if (target && target.isValid) return;
    const zombie = bot.nearestEntity((entity) => entity.name === "zombie");
    if (!zombie) return;
    target = zombie;
    ctx.log(\`hunter: engaging zombie at \${zombie.position.toArray().map(Math.round).join(", ")}\`);
    bot.pathfinder.setGoal(new goals.GoalFollow(zombie, 2), true);
  }, 1000);

  const swing = setInterval(() => {
    if (target && target.isValid && bot.entity.position.distanceTo(target.position) < 3.5) {
      bot.attack(target);
    }
  }, 300);

  ctx.signal.addEventListener("abort", () => {
    clearInterval(scan);
    clearInterval(swing);
  }, { once: true });
});
`;
