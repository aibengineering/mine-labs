import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("separate processes publish one complete server jar without leaving partial files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-download-"));
  const script = join(root, "download.mjs");
  try {
    await mkdir(join(root, "ready"));
    await writeFile(script, `
      import { writeFile, readdir } from 'node:fs/promises';
      import { join } from 'node:path';
      import { ensureServerJar } from ${JSON.stringify(new URL("./server.ts", import.meta.url).href)};
      const root = process.env.MINE_LABS_HOME;
      globalThis.fetch = async (url) => {
        if (String(url).includes('version_manifest')) return Response.json({ versions: [{ id: 'test', url: 'https://fixture/meta' }] });
        if (url === 'https://fixture/meta') return Response.json({ downloads: { server: { url: 'https://fixture/jar' } } });
        await writeFile(join(root, 'ready', String(process.pid)), 'ready');
        const deadline = Date.now() + 5000;
        while ((await readdir(join(root, 'ready'))).length < 2) {
          if (Date.now() > deadline) throw new Error('Second downloader did not arrive');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        return new Response('complete test jar');
      };
      await ensureServerJar('test', () => {});
    `);
    const run = (): Promise<void> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        env: { ...process.env, MINE_LABS_HOME: root }, windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let errors = "";
      child.stderr.on("data", chunk => { errors += String(chunk); });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(new Error(errors || `exit ${code}`)));
    });
    const results = await Promise.allSettled([run(), run()]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    const cache = join(root, "servers", "test");
    assert.deepEqual(await readdir(cache), ["server.jar"]);
    assert.equal(await readFile(join(cache, "server.jar"), "utf8"), "complete test jar");
  } finally { await rm(root, { recursive: true, force: true }); }
});
