// A Mineflayer client that checks, before `prepared`, that it observes the
// arrangement its scenario's `params.expect` names, and reports the result as
// its completion. Used by the live fixture integration test.
import { once } from "node:events";
import mineflayer from "mineflayer";
import { runNodeClient } from "../../client/node.ts";
import { itemId } from "../../util/minecraft.ts";

await runNodeClient(async (ctx) => {
  const bot = mineflayer.createBot({
    host: ctx.host, port: ctx.port, username: ctx.username, version: ctx.version, auth: "offline",
  });
  ctx.signal.addEventListener("abort", () => bot.quit(), { once: true });
  await once(bot, "spawn");
  ctx.ready();
  await ctx.arranged;
  const expect = ctx.scenario.params?.expectByPlayer?.[ctx.username] ?? ctx.scenario.params?.expect ?? {};
  const mismatches = () => {
    const found = [];
    for (const key of ["food", "saturation", "health"]) {
      const actual = { food: bot.food, saturation: bot.foodSaturation, health: bot.health }[key];
      if (expect[key] !== undefined && actual !== expect[key]) found.push(`${key} ${actual} != ${expect[key]}`);
    }
    // Declared stacks may carry components; the client sees the base id.
    const me = ctx.scenario.players.find((player) => player.name === ctx.username);
    const declared = [...(me?.inventory ?? []).map((stack) => stack.item), ...Object.values(me?.equipment ?? {})];
    for (const stack of declared) {
      const name = itemId(stack).replace(/^minecraft:/u, "");
      if (!bot.inventory.slots.some((slot) => slot?.name === name)) found.push(`no ${name}`);
    }
    for (const wanted of expect.items ?? []) {
      const items = bot.inventory.slots.filter((slot) => slot?.name === wanted.name);
      if (!items.some((item) => wanted.damage === undefined || item.durabilityUsed === wanted.damage)) {
        found.push(`${wanted.name} damage ${items.map((item) => item.durabilityUsed).join("/") || "absent"} != ${wanted.damage}`);
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
