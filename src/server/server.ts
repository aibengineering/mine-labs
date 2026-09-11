/**
 * Own one real Minecraft server: fetch it, configure it, start it, stop it.
 *
 * Mine Labs tests against genuine vanilla Minecraft rather than a simulation,
 * because the whole value of the harness is that a client which passes here
 * would pass against the real game. That decision makes this module
 * responsible for a lot of unglamorous reality: downloading the right server
 * jar from Mojang and caching it per version, generating `server.properties`
 * and `eula.txt`, seeding `ops.json` so named humans can join, leasing a free
 * game/RCON port pair, and waiting for a server that takes tens of seconds to
 * boot.
 *
 * Shutdown gets disproportionate attention on purpose. A Minecraft server that
 * refuses to stop holds its world files and its ports, which would break the
 * *next* trial rather than this one, so `stop()` escalates from a polite RCON
 * `stop` through SIGKILL and gives up its handles rather than ever blocking
 * forever.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Rcon } from "./rcon.js";
import { mineLabsHome, writeTextFile, delay } from "../util/fs.js";
import { reserveFreePortPair, type PortPairLease } from "./ports.js";
import { linkServerRuntime } from "./runtime.js";
import { registerManagedChild, settledWithin, terminateProcessTree, waitForChildExit } from "../process/children.js";
import { defaultOperatorProfiles, offlinePlayerUuid, type OperatorProfile } from "./operator-policy.js";

const VERSION_MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const serverJarPreparations = new Map<string, Promise<string>>();
const SERVER_STOP_GRACE_MS = 8_000;
const SERVER_KILL_GRACE_MS = 5_000;
const RCON_CLOSE_GRACE_MS = 2_000;

export async function ensureServerJar(version: string, log: (s: string) => void): Promise<string> {
  const dir = join(mineLabsHome(), "servers", version);
  const jar = join(dir, "server.jar");
  if (existsSync(jar)) return jar;
  const active = serverJarPreparations.get(version);
  if (active) return active;

  const preparation = downloadServerJar(version, dir, jar, log);
  serverJarPreparations.set(version, preparation);
  try {
    return await preparation;
  } finally {
    if (serverJarPreparations.get(version) === preparation) serverJarPreparations.delete(version);
  }
}

async function downloadServerJar(version: string, dir: string, jar: string, log: (s: string) => void): Promise<string> {
  log(`downloading Minecraft ${version} server jar…`);
  const manifest = (await fetch(VERSION_MANIFEST).then((r) => r.json())) as {
    versions: { id: string; url: string }[];
  };
  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) throw new Error(`version '${version}' not found in Mojang manifest`);
  const meta = (await fetch(entry.url).then((r) => r.json())) as {
    downloads: { server: { url: string } };
  };
  const url = meta.downloads.server.url;
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `server-${randomUUID()}.jar.part`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`server jar download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  try {
    await writeFile(tmp, buf, { flag: "wx" });
    // Publish a complete file without replacing a concurrent process's winner.
    await link(tmp, jar).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    });
  } finally {
    await rm(tmp, { force: true });
  }
  log(`server jar ready: ${jar}`);
  return jar;
}

export interface ServerConfig {
  version: string;
  worldDir: string;
  rconPort: number;
  gamePort: number;
  rconPassword: string;
  worldType: "flat" | "default";
  seed?: number | string;
  structures: boolean;
  operators: OperatorProfile[];
  maxPlayers?: number;
}

export class MinecraftServer {
  rcon?: Rcon;
  private proc?: ChildProcess;
  private spawnFailure?: Error;

  constructor(
    private cfg: ServerConfig,
    private jar: string,
    private log: (s: string) => void,
    private ports: PortPairLease,
  ) {}

  get worldDir(): string {
    return this.cfg.worldDir;
  }

  get gamePort(): number {
    return this.cfg.gamePort;
  }

  get operatorNames(): readonly string[] {
    return this.cfg.operators.map((operator) => operator.name);
  }

  static async create(opts: {
    version: string;
    root: string;
    log: (s: string) => void;
    preferPort?: number;
    worldType?: "flat" | "default";
    seed?: number | string;
    structures?: boolean;
    maxPlayers?: number;
    spectatorNames?: string[];
  }): Promise<MinecraftServer> {
    // Validate local configuration before acquiring resources that need release.
    const operators = defaultOperatorProfiles();
    await linkServerRuntime(opts.root, opts.version);
    const ports = await reserveFreePortPair(opts.preferPort ?? 25565);
    const cfg: ServerConfig = {
      version: opts.version,
      worldDir: join(opts.root, "world"),
      rconPort: ports.rconPort,
      gamePort: ports.gamePort,
      rconPassword: Math.random().toString(36).slice(2, 10),
      worldType: opts.worldType ?? "flat",
      seed: opts.seed,
      structures: opts.structures ?? false,
      maxPlayers: opts.maxPlayers,
      operators: [...operators, ...(opts.spectatorNames ?? []).map((name): OperatorProfile => ({
        name, uuid: offlinePlayerUuid(name), level: 2, bypassesPlayerLimit: true,
      }))],
    };
    try {
      const jar = await ensureServerJar(opts.version, opts.log);
      return new MinecraftServer(cfg, jar, opts.log, ports);
    } catch (error) {
      ports.release();
      throw error;
    }
  }

  private async writeConfig(): Promise<void> {
    const lines = [
      // Vanilla uses server-ip for both its game listener and RCON listener.
      "server-ip=127.0.0.1",
      `server-port=${this.cfg.gamePort}`,
      "online-mode=false",
      // Scenario bots must be able to modify fixtures near the generated
      // spawn even after another scenario has added an operator.
      "spawn-protection=0",
      "enable-rcon=true",
      `rcon.port=${this.cfg.rconPort}`,
      `rcon.password=${this.cfg.rconPassword}`,
      "level-name=world",
      `level-type=${this.cfg.worldType === "flat" ? "minecraft\\:flat" : "minecraft\\:normal"}`,
      ...(this.cfg.worldType === "flat"
        ? [
            // Classic superflat. Layers stack from the dimension floor, so
            // this is bedrock at y=-64, dirt at -63 and -62, grass top at -61,
            // and a player stands at y=-60 — which is what the run logs show.
            // Nothing derives those numbers programmatically, deliberately: the
            // arena snapshot in `scenario/compile.ts` copies whatever blocks
            // are actually there rather than reconstructing this preset, so
            // changing these layers cannot desynchronise world resets.
            // Colons must be backslash-escaped in server.properties.
            'generator-settings={"biome"\\:"minecraft\\:plains","lakes"\\:false,"features"\\:false,"layers"\\:[{"block"\\:"minecraft\\:bedrock","height"\\:1},{"block"\\:"minecraft\\:dirt","height"\\:2},{"block"\\:"minecraft\\:grass_block","height"\\:1}],"structure_overrides"\\:[]}',
          ]
        : []),
      // A scenario that names a seed means it. Without this the option was
      // accepted, threaded through the config, and then never written, so
      // every `default` world was freshly random. A fixture pinned to a seed
      // measured different terrain on every run, which reads as a wildly flaky
      // client rather than as a world that was never the same twice.
      ...(this.cfg.seed === undefined ? [] : [`level-seed=${this.cfg.seed}`]),
      `generate-structures=${this.cfg.structures}`,
      "spawn-monsters=true",
      "spawn-animals=false",
      "view-distance=8",
      "simulation-distance=8",
      `max-players=${this.cfg.maxPlayers ?? 10}`,
    ];
    const root = join(this.cfg.worldDir, "..");
    await writeTextFile(join(root, "server.properties"), lines.join("\n"));
    // The vanilla server gates on eula.txt, not the server.properties key.
    await writeTextFile(join(root, "eula.txt"), "eula=true\n");
    await writeTextFile(join(root, "ops.json"), `${JSON.stringify(this.cfg.operators, null, 2)}\n`);
  }

  async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const root = join(this.cfg.worldDir, "..");
    await mkdir(root, { recursive: true });
    await this.writeConfig();
    const javaName = process.platform === "win32" ? "javaw.exe" : "java";
    const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", javaName) : javaName;
    this.log(`starting ${this.cfg.version} server on :${this.cfg.gamePort} (rcon :${this.cfg.rconPort})`);
    this.proc = spawn(java, ["-Xms512M", "-Xmx2G", "-jar", this.jar, "nogui"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    registerManagedChild(this.proc);
    this.proc.stdout?.on("data", (d) => this.log(`[server] ${String(d).trimEnd()}`));
    this.proc.stderr?.on("data", (d) => this.log(`[server] ${String(d).trimEnd()}`));
    this.proc.once("error", (error) => {
      this.spawnFailure = error;
      this.log(`[server] process error: ${error.message}`);
    });
    this.proc.on("exit", (code) => this.log(`[server] exited code=${code}`));
    await this.waitReady(signal);
  }

  private async waitReady(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (this.spawnFailure) throw this.spawnFailure;
      if (this.proc && this.proc.exitCode !== null) {
        throw new Error(`server exited with code ${this.proc.exitCode} before becoming ready`);
      }
      try {
        this.rcon = new Rcon("127.0.0.1", this.cfg.rconPort, this.cfg.rconPassword);
        await this.rcon.connect();
        const out = await this.rcon.command("list");
        if (out !== "") {
          this.log("server ready");
          return;
        }
      } catch {
        // not up yet
      }
      this.rcon?.close();
      await delay(1000);
    }
    throw new Error("server did not become ready within 180s");
  }

  async stop(options?: { force?: boolean }): Promise<void> {
    const proc = this.proc;
    try {
      if (!options?.force) {
        try {
          if (this.rcon) await this.rcon.command("stop");
        } catch {
          // fall through to kill
        }
      }
      try {
        if (this.rcon && !(await settledWithin(this.rcon.close(), RCON_CLOSE_GRACE_MS))) {
          this.log(`[server] RCON disconnect exceeded ${RCON_CLOSE_GRACE_MS}ms; continuing shutdown`);
        }
      } catch (error) {
        this.log(`[server] RCON disconnect failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.rcon = undefined;

      const stopGrace = options?.force ? 0 : SERVER_STOP_GRACE_MS;
      if (proc && (stopGrace === 0 || !(await waitForChildExit(proc, stopGrace)))) {
        try {
          terminateProcessTree(proc);
        } catch (error) {
          this.log(`[server] process tree termination failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!(await waitForChildExit(proc, SERVER_KILL_GRACE_MS))) {
          this.log(`[server] process remained active after ${SERVER_KILL_GRACE_MS}ms; abandoning attached handles`);
          proc.stdout?.destroy();
          proc.stderr?.destroy();
          proc.unref();
        }
      }
      this.proc = undefined;
      this.spawnFailure = undefined;
    } finally {
      this.ports.release();
    }
  }
}

/** Wipe the world so every run generates a fresh flat world (deterministic with a fixed seed). */
export async function prepareWorldDir(worldDir: string): Promise<void> {
  await rm(worldDir, { recursive: true, force: true });
  await mkdir(worldDir, { recursive: true });
}
