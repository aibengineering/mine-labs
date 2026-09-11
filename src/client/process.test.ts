import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchScenarioClient } from "./process.js";
import type { ClientCompletion } from "./protocol.js";
import { scenarioSchema } from "../scenario/schema.js";

test("a language-neutral client observes arrangement before start", async () => {
  const fixture = fileURLToPath(new URL("./test-fixtures/protocol-client.mjs", import.meta.url));
  const logs: string[] = [];
  const chats: string[] = [];
  const completion = Promise.withResolvers<ClientCompletion>();
  const scenario = scenarioSchema.parse({
    name: "protocol-fixture",
    client: { command: process.execPath, args: [fixture], env: { MINE_LABS_TEST_ENV: "passed" } },
    players: [{ name: "ClientBot" }],
    goal: { kind: "completion", who: "ClientBot" },
  });
  const { client: clientCommand, ...definition } = scenario;

  const client = launchScenarioClient({
    client: clientCommand,
    scenario: definition,
    host: "127.0.0.1",
    port: 25565,
    username: "ClientBot",
    version: "1.21.4",
    artifactsDirectory: "test-artifacts",
    log: (message) => logs.push(message),
    onChat: (message) => chats.push(message),
    onCompletion: completion.resolve,
  });

  await client.ready;
  client.arranged();
  await client.prepared;
  client.start();
  assert.deepEqual(await completion.promise, { status: "succeeded", detail: "fixture complete" });
  assert.deepEqual(chats, ["fixture chat"]);
  assert.ok(logs.some((message) => message.includes("connected as ClientBot")));
  assert.ok(logs.some((message) => message.includes("received launch config: false")));
  assert.ok(logs.some((message) => message.includes("environment: passed")));
  assert.ok(logs.some((message) => message.includes("artifacts: test-artifacts")));
  assert.ok(logs.some((message) => message.includes("observed scenario arrangement")));
  await client.stop("test complete");
});

test("a client that ignores the stop handoff is still brought down", async () => {
  // Regression: `stop` used to send one signal and then wait on an exit that a
  // wedged client would never deliver. With the goal already judged and the
  // server still up, the whole harness hung there — a scenario suite would
  // stall on one row rather than record it and move on.
  const fixture = fileURLToPath(new URL("./test-fixtures/deaf-client.mjs", import.meta.url));
  const scenario = scenarioSchema.parse({
    name: "deaf-fixture",
    client: { command: process.execPath, args: [fixture] },
    players: [{ name: "DeafBot" }],
    goal: { kind: "completion", who: "DeafBot" },
  });
  const { client: clientCommand, ...definition } = scenario;

  const client = launchScenarioClient({
    client: clientCommand,
    scenario: definition,
    host: "127.0.0.1",
    port: 25565,
    username: "DeafBot",
    version: "1.21.4",
    artifactsDirectory: "test-artifacts",
    log: () => undefined,
    onChat: () => undefined,
    onCompletion: () => undefined,
  });

  await client.ready;
  client.arranged();
  await client.prepared;
  client.start();
  const startedAt = Date.now();
  await client.stop("test complete");
  // The grace periods bound this at roughly a second plus one escalation; the
  // assertion only has to prove it returns at all, and well inside the time a
  // trial would otherwise have hung.
  assert.ok(Date.now() - startedAt < 20_000, `stop took ${Date.now() - startedAt} ms`);
});
