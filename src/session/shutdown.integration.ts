import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { delay } from "../util/fs.js";

async function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    // Windows can bind a second socket to a listening port; probe the listener instead.
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => { socket.destroy(); resolve(true); });
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

test("CLI shutdown releases ports for the next run", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-session-shutdown-"));
  const port = 29580;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.ok(await portFree(port));
      assert.ok(await portFree(port + 1));
      const child = spawn("bun", ["./bin/mine-labs.mjs", "run", "examples/scenarios/beacon-walk.yaml",
        "--repeat", "forever", "--port", String(port), "--out", root], {
        cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        env: { ...process.env, MINE_LABS_CONFIG: join(root, "no-operator-config.json") },
      });
      let output = "";
      child.stdout.on("data", data => { output += data; });
      child.stderr.on("data", data => { output += data; });
      const exited = new Promise(resolve => child.once("exit", resolve));
      try {
        const readyDeadline = Date.now() + 25_000;
        while (await portFree(port) && Date.now() < readyDeadline && child.exitCode === null) await delay(100);
        assert.equal(await portFree(port), false, output);
        child.kill("SIGINT");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([exited, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("session did not stop: " + output)), 12_000);
          })]);
        } finally { clearTimeout(timer); }
        const releaseDeadline = Date.now() + 5000;
        while ((!await portFree(port) || !await portFree(port + 1)) && Date.now() < releaseDeadline) await delay(100);
        assert.ok(await portFree(port), "game port released");
        assert.ok(await portFree(port + 1), "RCON port released");
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
