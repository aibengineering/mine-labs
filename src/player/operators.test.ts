import assert from "node:assert/strict";
import test from "node:test";
import { applyOperatorSpectatorPolicy, observerCameraCommand, watchOperatorSpectators, type OperatorCommandHost } from "./operators.js";

class FakeOperatorHost implements OperatorCommandHost {
  readonly commands: string[] = [];
  online = new Set<string>();

  async command(command: string): Promise<string> {
    this.commands.push(command);
    return "";
  }

  async playerOnline(name: string): Promise<boolean> {
    return this.online.has(name);
  }
}

test("spectators wait for preparation and are placed only on arrival", async () => {
  const host = new FakeOperatorHost();
  host.online.add("Observer");
  host.online.add("NetherBot");
  let ready = false;
  const options = { commands: host, operatorNames: ["Observer"], clientPlayerNames: ["NetherBot"],
    placed: new Set<string>(), viewpointPlayer: "NetherBot", viewpointReady: () => ready };
  await applyOperatorSpectatorPolicy(options);
  assert.ok(host.commands.includes("gamemode spectator Observer"));
  assert.ok(!host.commands.some(command => command.includes("tp ")));
  assert.equal(options.placed.size, 0);
  ready = true;
  host.online.delete("NetherBot");
  await applyOperatorSpectatorPolicy(options);
  assert.equal(options.placed.size, 0, "wait for the bot rather than marking placement complete");
  host.online.add("NetherBot");
  await applyOperatorSpectatorPolicy(options);
  assert.equal(host.commands.at(-1), observerCameraCommand("Observer", "NetherBot"), "camera placement carries the bot's dimension and actual position");
  host.commands.length = 0;
  await applyOperatorSpectatorPolicy(options);
  assert.deepEqual(host.commands, [], "free flight is not overwritten each poll");
  host.online.delete("Observer");
  await applyOperatorSpectatorPolicy(options);
  host.online.add("Observer");
  await applyOperatorSpectatorPolicy(options);
  assert.equal(host.commands.at(-1), observerCameraCommand("Observer", "NetherBot"));
  // Coordinate fallback has the same arrival policy, but a different teleport target.
  await applyOperatorSpectatorPolicy({ ...options, placed: new Set(),
    viewpointPlayer: undefined, viewpoint: [0, -58, 0] });
  assert.deepEqual(host.commands.slice(-3), [
    "gamemode spectator Observer",
    "effect give Observer minecraft:night_vision infinite 1 true",
    "tp Observer 0 -58 0",
  ]);
});

test("placement waits for an active arrival poll", async () => {
  const host = new FakeOperatorHost();
  host.online = new Set(["Observer", "NetherBot"]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  host.playerOnline = async name => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return host.online.has(name);
  };
  let ready = false;
  const watch = watchOperatorSpectators({commands: host, operatorNames: ["Observer"],
    clientPlayerNames: ["NetherBot"], viewpointPlayer: "NetherBot", viewpointReady: () => ready, log: () => {}});
  try {
    await entered.promise;
    ready = true;
    let placed = false;
    const placement = watch.place().then(() => { placed = true; });
    await Promise.resolve();
    assert.equal(placed, false);
    release.resolve();
    await placement;
    assert.equal(host.commands.filter(command => command.includes("run tp ")).length, 1);
    assert.equal(host.commands.at(-1), observerCameraCommand("Observer", "NetherBot"));
  } finally { release.resolve(); watch.stop(); }
});

test("operator policy leaves scenario players alone", async () => {
  const host = new FakeOperatorHost();
  host.online.add("fighter");

  const placedNow = await applyOperatorSpectatorPolicy({
    commands: host,
    operatorNames: ["Fighter"],
    clientPlayerNames: ["fighter"],
    placed: new Set<string>(),
  });

  assert.deepEqual(placedNow, []);
  assert.deepEqual(host.commands, []);
});
