import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchScenarioClient } from "./process.js";
import type { ClientCompletion } from "./protocol.js";
import { scenarioSchema } from "../scenario/schema.js";
import { settledWithin } from "../process/children.js";

for (const mode of ["0", "23", "finished", "stopped"]) {
  test(`client exit preserves terminal evidence: ${mode}`, async () => {
    const fixture = fileURLToPath(
      new URL("./test-fixtures/exiting-client.mjs", import.meta.url),
    );
    const scenario = scenarioSchema.parse({
      name: "exit-fixture",
      client: { command: process.execPath, args: [fixture, mode] },
      players: [{ name: "ExitBot" }],
      goal: { kind: "completion", who: "ExitBot" },
    });
    const { client: command, ...definition } = scenario;
    const completions: ClientCompletion[] = [];
    const ended = Promise.withResolvers<void>();
    const client = launchScenarioClient({
      client: command,
      scenario: definition,
      host: "127.0.0.1",
      port: 25565,
      username: "ExitBot",
      version: "1.21.4",
      artifactsDirectory: "test-artifacts",
      log: (message) => {
        if (message.includes("exited")) ended.resolve();
      },
      onChat: () => undefined,
      onCompletion: (completion) => completions.push(completion),
    });
    try {
      await client.ready;
      client.arranged();
      await client.prepared;
      if (mode === "stopped") {
        await client.stop("normal teardown");
        assert.deepEqual(completions, []);
        return;
      }
      client.start();
      // Bound only a broken test process; production completion follows its exit.
      assert.equal(
        await settledWithin(ended.promise, 2000),
        true,
        "client did not exit",
      );
      assert.equal(completions.length, 1);
      if (mode === "finished") {
        assert.deepEqual(completions[0], {
          status: "succeeded",
          detail: "observed outcome",
        });
      } else {
        assert.equal(completions[0]!.status, "failed");
        assert.match(
          completions[0]!.detail!,
          new RegExp(`exited with code ${mode}`),
        );
      }
    } finally {
      await client.stop("test cleanup");
    }
  });
}
