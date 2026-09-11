/**
 * Mine Labs' one channel for talking to a running Minecraft server.
 *
 * RCON is Valve's remote-console protocol, which Minecraft implements; it is
 * the only interface vanilla offers for driving a server you have not modded.
 * Everything the harness does to a world - building fixtures, positioning
 * players, and every observation a goal makes - goes through here.
 *
 * Two problems this layer exists to solve:
 *
 * 1. **RCON returns prose, not data.** There is no way to ask "how many zombies
 *    are there" and get a number. So queries are wrapped as
 *    `execute store result/success score ... run <command>`, which makes vanilla
 *    write the answer into a scoreboard, and a second command reads it back.
 *    The scoreboard is the typed return channel the protocol lacks.
 *
 * 2. **The transport is not safe to use concurrently.** `rcon-srcds` matches
 *    responses to requests with a random packet id and a raw `data` listener,
 *    and treats each TCP chunk as exactly one whole packet - which is not a
 *    guarantee TCP makes. Two requests in flight at once can have their
 *    responses coalesced or split, and a misparsed response is one no listener
 *    ever claims, hanging that command forever. Every call therefore goes
 *    through one serialising queue, and every command is additionally bounded
 *    by a timeout, because the library's own `timeout` option is never armed.
 */

import RconClientModule from "rcon-srcds";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Dimension } from "../scenario/schema.js";
import { inDimension, resourceId } from "../util/minecraft.js";

interface RconTransport {
  authenticate(password: string): Promise<boolean>;
  execute(command: string): Promise<string | boolean>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  /** The live socket, which `rcon-srcds` exposes but does not keep guarded. */
  connection?: { on(event: "error", listener: (cause: unknown) => void): unknown };
}

type RconTransportConstructor = new (options: {
  host: string;
  port: number;
  encoding: "utf8";
  timeout: number;
}) => RconTransport;

const RconClient = resolveRconClient(RconClientModule);

/** Mine Labs' server-observation API over a maintained Source RCON transport. */
export class Rcon {
  private readonly client: RconTransport;
  private queryQueue: Promise<void> = Promise.resolve();
  private queryObjectivesReady?: Promise<void>;

  constructor(host: string, port: number, private password: string) {
    this.client = new RconClient({ host, port, encoding: "utf8", timeout: 5_000 });
  }

  async connect(): Promise<void> {
    await this.client.authenticate(this.password);
    // `rcon-srcds` guards the socket only for the duration of the connect
    // handshake: it attaches `once("error", reject)` and removes it again the
    // moment authentication succeeds. From then on the socket carries no error
    // listener, so a later reset — the server going away under a slow poll is
    // the usual one — reaches Node as an unhandled "error" event and takes the
    // whole harness process down, losing every result in the run rather than
    // failing the one observation that could not be made.
    this.client.connection?.on("error", (cause) => {
      this.socketFailure = cause instanceof Error ? cause : new Error(String(cause));
    });
  }

  /**
   * Why the transport stopped working, if it did. Commands issued after this
   * is set will fail on their own; recording it just lets them say why.
   */
  private socketFailure?: Error;

  /**
   * Whether this asynchronous caller already owns the queued operation.
   * A connection-wide depth counter lets unrelated callers bypass the queue
   * while another query is awaiting its response. Scope ownership to the caller.
   *
   * `rcon-srcds` matches responses to requests with a random 1-255 packet id
   * and a raw `'data'` listener per call, with no framing across chunk
   * boundaries — two requests in flight at once on the same socket can have
   * their responses coalesce into one TCP read or split across two, and the
   * decoder cannot tell. `command()` uses this to make sure it is never one
   * of those concurrent requests: called from outside any `query()` it
   * enqueues itself onto `queryQueue` like every other RCON call; called from
   * inside one (`executeChecked`, `storeResult`, ...) it is already part of
   * that serialized operation, so it runs directly rather than re-enqueuing
   * behind itself, which would deadlock.
   */
  private readonly queryScope = new AsyncLocalStorage<boolean>();

  async command(cmd: string): Promise<string> {
    if (this.queryScope.getStore()) return this.rawCommand(cmd);
    return this.query(() => this.rawCommand(cmd));
  }

  /** `protected` so a test can fake the transport while exercising the real queue/depth logic in `command()`. */
  protected async rawCommand(cmd: string): Promise<string> {
    if (this.socketFailure) throw new Error(`rcon connection lost: ${this.socketFailure.message}`);
    const c = cmd.startsWith("/") ? cmd.slice(1) : cmd;
    // The transport's own `timeout` option only sets a socket idle timeout
    // during `connect()`, which nothing ever subscribes to — it does not
    // bound `execute()`. Without this, a lost response hangs forever.
    const response = await withTimeout(
      this.client.execute(c),
      COMMAND_TIMEOUT_MS,
      `rcon command timed out after ${COMMAND_TIMEOUT_MS}ms: ${c}`,
    );
    if (typeof response !== "string") throw new Error(`rcon returned no text response for: ${c}`);
    return response;
  }

  /** Execute one world-arrangement command and verify Minecraft accepted it. */
  executeChecked(cmd: string, options: { acceptedNoOp?: RegExp } = {}): Promise<string> {
    return this.query(async () => {
      await this.ensureQueryObjectives();
      // Strip the caller's leading slash before wrapping. `command` only strips
      // one from the outer string, so a scenario written the way the README
      // shows — `run: "/setworldspawn 0 -59 0"` — became
      // `execute ... run /setworldspawn ...`, which is a parse error and
      // reported as "setup command failed" against a command that is fine.
      const inner = cmd.startsWith("/") ? cmd.slice(1) : cmd;
      const output = await this.command(`execute store success score #ml_command ml_query run ${inner}`);
      const succeeded = (await this.readScore("#ml_command", "ml_query")) === 1;
      if (!succeeded && !options.acceptedNoOp?.test(output)) {
        throw new Error(`setup command failed: ${inner}${output ? ` → ${output}` : ""}`);
      }
      return output;
    });
  }

  /** Server-side observations keep Mine Labs independent of any client library. */
  countEntities(type: string): Promise<number> {
    const entity = resourceId(type);
    return this.query(async () => this.storeResult(`execute if entity @e[type=${entity}]`));
  }

  /** Goal coordinates belong to the named player's current dimension. */
  playerWithin(name: string, pos: readonly [number, number, number], radius: number): Promise<boolean> {
    return this.query(async () =>
      this.storeSuccess(`execute as ${name} at @s positioned ${pos[0]} ${pos[1]} ${pos[2]} if entity @s[distance=..${radius}]`),
    );
  }

  playerFarFromEntities(name: string, type: string, distance: number): Promise<boolean> {
    return this.query(async () =>
      this.storeSuccess(
        `execute at ${name} unless entity @e[type=${resourceId(type)},distance=..${distance}]`,
      ),
    );
  }

  playerOnline(name: string): Promise<boolean> {
    return this.query(async () => this.storeSuccess(`execute if entity @a[name=${name}]`));
  }

  playerWithinHorizontalRadius(name: string, x: number, z: number, radius: number): Promise<boolean> {
    return this.query(() => this.storeSuccess(
      `execute as ${name} at @s positioned ${x} ~ ${z} if entity @s[distance=..${radius}]`,
    ));
  }

  countPlayerItems(name: string, item: string): Promise<number> {
    return this.query(async () => {
      // Even /clear with a zero limit broadcasts container/result-slot updates.
      // Copy counts from player NBT instead, leaving an active craft untouched.
      await this.command("data modify storage mine_labs:query item_counts set value []");
      await this.command(
        `data modify storage mine_labs:query item_counts append from entity ${name} Inventory[{id:${JSON.stringify(resourceId(item))}}].count`,
      );
      const output = await this.command("data get storage mine_labs:query item_counts");
      const list = output.match(/\[[\s\S]*\]$/u)?.[0];
      if (!list) throw new Error(`Server did not return inventory counts: ${output}`);
      const counts = z.array(z.number().int().nonnegative()).parse(JSON.parse(list));
      return counts.reduce((total, count) => total + count, 0);
    });
  }

  /** Block coordinates belong to the scenario's arena dimension, unlike a player's. */
  blockMatches(pos: readonly [number, number, number], block: string, dimension: Dimension = "overworld"): Promise<boolean> {
    return this.query(async () =>
      this.storeSuccess(inDimension(dimension, `execute if block ${pos.join(" ")} ${resourceId(block)}`)),
    );
  }

  playerHealth(name: string): Promise<number> {
    return this.query(async () => (await this.storeResult(`data get entity ${name} Health 100`)) / 100);
  }

  playerDeaths(name: string): Promise<number> {
    return this.query(async () => {
      await this.ensureQueryObjectives();
      return this.readScore(name, "ml_deaths");
    });
  }

  preparePlayerMetrics(name: string): Promise<void> {
    return this.query(async () => {
      await this.ensureQueryObjectives();
      await this.command(`scoreboard players set ${name} ml_deaths 0`);
    });
  }

  private query<T>(operation: () => Promise<T>): Promise<T> {
    const run = (): Promise<T> => this.queryScope.run(true, operation);
    const result = this.queryQueue.then(run, run);
    this.queryQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureQueryObjectives(): Promise<void> {
    const initialization = this.queryObjectivesReady ??= (async () => {
      await this.command("scoreboard objectives add ml_query dummy");
      await this.command("scoreboard objectives add ml_deaths deathCount");
    })();
    try {
      await initialization;
    } catch (error) {
      if (this.queryObjectivesReady === initialization) this.queryObjectivesReady = undefined;
      throw error;
    }
  }

  private async storeResult(command: string): Promise<number> {
    await this.ensureQueryObjectives();
    await this.command(`execute store result score #ml_result ml_query run ${command}`);
    return this.readScore("#ml_result", "ml_query");
  }

  private async storeSuccess(command: string): Promise<boolean> {
    await this.ensureQueryObjectives();
    await this.command(`execute store success score #ml_result ml_query run ${command}`);
    return (await this.readScore("#ml_result", "ml_query")) === 1;
  }

  private async readScore(holder: string, objective: string): Promise<number> {
    const output = await this.command(`scoreboard players get ${holder} ${objective}`);
    const numbers = output.match(/-?\d+/gu);
    return numbers ? Number(numbers.at(-1)) : 0;
  }

  async close(): Promise<void> {
    if (this.client.isConnected()) await this.client.disconnect();
  }
}

/** Generous enough for a `reload`, well short of "forever". */
const COMMAND_TIMEOUT_MS = 10_000;

/**
 * Race a promise against a timer, since `rcon-srcds`'s own `execute()` has
 * nothing that bounds it (see `rawCommand`).
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Normalize the package's CommonJS default export under both Node and Bun. */
function resolveRconClient(imported: unknown): RconTransportConstructor {
  if (typeof imported === "function") return imported as RconTransportConstructor;
  if (typeof imported === "object" && imported !== null && "default" in imported) {
    const nested = imported.default;
    if (typeof nested === "function") return nested as RconTransportConstructor;
  }
  throw new TypeError("rcon-srcds did not export an RCON client constructor");
}
