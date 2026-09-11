// Walker client: paths to the scenario goal position supplied by the scenario.
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
  const goal = ctx.scenario.goal;
  const pos = goal.kind === "reach" && Array.isArray(goal.pos) ? goal.pos : [0, -59, 0];
  ctx.log(`walker: heading to ${pos.join(", ")}`);
  bot.pathfinder.setGoal(new goals.GoalNear(pos[0], pos[1], pos[2], goal.radius ?? 1));
  bot.once("goal_reached", () => ctx.log("walker: arrived"));
});
