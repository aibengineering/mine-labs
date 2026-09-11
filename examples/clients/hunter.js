// Hunter client: finds the nearest zombie, paths to it, and attacks until it dies.
// Works on mineflayer 4.x + mineflayer-pathfinder 2.x.
import { once } from "node:events";
import pathfinderPkg from "mineflayer-pathfinder";
import mineflayer from "mineflayer";
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
    const zombie = bot.nearestEntity((e) => e.name === "zombie");
    if (!zombie) return;
    target = zombie;
    ctx.log(`hunter: engaging zombie at ${zombie.position.toArray().map(Math.round).join(", ")}`);
    bot.pathfinder.setGoal(new goals.GoalFollow(zombie, 2), true);
  }, 1000);

  const swing = setInterval(() => {
    if (target && target.isValid && bot.entity.position.distanceTo(target.position) < 3.5) {
      bot.attack(target);
    }
  }, 300);

  ctx.signal.addEventListener(
    "abort",
    () => {
      clearInterval(scan);
      clearInterval(swing);
    },
    { once: true },
  );
});
