import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lockClientRuntime } from "./runtime-lock.js";

test("a client runtime rejects a second owner and recovers a dead owner's lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-client-lock-"));
  try {
    const release = await lockClientRuntime(root);
    try { await assert.rejects(lockClientRuntime(root), /another session/); }
    finally { await release(); }
    const child = spawn(process.execPath, ["-e", ""], { windowsHide: true, stdio: "ignore" });
    await once(child, "close");
    await writeFile(join(root, "session.lock"), String(child.pid));
    const recovered = await lockClientRuntime(root);
    await recovered();
  } finally { await rm(root, { recursive: true, force: true }); }
});
