// A Mineflayer client that checks, before `prepared`, that it observes the
// arrangement its scenario's `params.expect` names, and reports the result as
// its completion. Used by the live fixture integration test.
import { once } from "node:events";
import mineflayer from "mineflayer";
import { runNodeClient } from "../../client/node.ts";

await runNodeClient(async (ctx) => {
  const bot = mineflayer.createBot({
    host: ctx.host, port: ctx.port, username: ctx.username, version: ctx.version, auth: "offline",
  });
  ctx.signal.addEventListener("abort", () => bot.quit(), { once: true });
  await once(bot, "spawn");
  ctx.ready();
  await ctx.arranged;
  const expect = ctx.scenario.params?.expect ?? {};
  const mismatches = () => {
    const found = [];
    for (const key of ["food", "saturation", "health"]) {
      const actual = { food: bot.food, saturation: bot.foodSaturation, health: bot.health }[key];
      if (expect[key] !== undefined && actual !== expect[key]) found.push(`${key} ${actual} != ${expect[key]}`);
    }
    for (const wanted of expect.items ?? []) {
      const item = [...bot.inventory.slots].find((slot) => slot?.name === wanted.name);
      if (!item) found.push(`no ${wanted.name}`);
      else if (wanted.damage !== undefined && item.durabilityUsed !== wanted.damage) {
        found.push(`${wanted.name} damage ${item.durabilityUsed} != ${wanted.damage}`);
      }
    }
    return found;
  };
  const deadline = Date.now() + 3000;
  while (mismatches().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  const observed = mismatches();
  ctx.log(`observed food ${bot.food}, saturation ${bot.foodSaturation}, health ${bot.health}`);
  ctx.prepared();
  await ctx.start;
  if (ctx.signal.aborted) return;
  // Hold the trial open long enough for the world goals to be measured.
  await new Promise((resolve) => setTimeout(resolve, ctx.scenario.params?.holdMs ?? 0));
  ctx.finish(observed.length
    ? { status: "failed", detail: observed.join("; ") }
    : { status: "succeeded", detail: "arrangement observed" });
});
