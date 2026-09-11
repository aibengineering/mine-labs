/**
 * Own the lifetime of one external scenario client process.
 *
 * Clients are arbitrary programs in any language — that is the point of the
 * harness — so Mine Labs cannot call into them. It spawns them and speaks the
 * JSON-lines protocol in `client/protocol.ts` over stdin/stdout, which makes
 * this module the place where an uncooperative foreign process is contained.
 *
 * The handshake it drives is three-phase, and each phase exists to remove a way
 * a measurement could lie: `ready` (the client has connected and its player is
 * in the world), `prepared` (the client has observed the arranged fixture, so
 * it is not deciding based on a world that was still being built), and only
 * then `start`. Every phase is bounded by a timeout and every shutdown path
 * escalates — stop message, SIGTERM, SIGKILL, then abandoning the pipes —
 * because a client that ignores all of it must still not be able to hang a
 * trial whose goal has already been decided.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
  CLIENT_PROTOCOL_VERSION,
  encodeClientMessage,
  parseClientEvent,
  type ClientCommand,
  type ClientCompletion,
} from "./protocol.js";
import type { ClientCommandSpec, ScenarioDefinition } from "../scenario/schema.js";
import { registerManagedChild, settledWithin } from "../process/children.js";

export interface ScenarioClientProcess {
  readonly ready: Promise<void>;
  readonly prepared: Promise<void>;
  arranged(): void;
  start(): void;
  stop(reason: string): Promise<void>;
}

export interface LaunchScenarioClientOptions {
  client: ClientCommandSpec;
  scenario: ScenarioDefinition;
  host: string;
  port: number;
  username: string;
  version: string;
  artifactsDirectory: string;
  readyTimeoutMs?: number;
  preparedTimeoutMs?: number;
  log: (message: string) => void;
  onChat: (message: string) => void;
  onCompletion: (completion: ClientCompletion) => void;
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_PREPARED_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 1_000;
/** How long a signalled client gets before the next, harder signal. */
const SIGNAL_GRACE_MS = 5_000;

/** Launch one scenario client behind the language-neutral JSON-lines protocol. */
export function launchScenarioClient(options: LaunchScenarioClientOptions): ScenarioClientProcess {
  const child = spawnClient(options.client, options.artifactsDirectory);
  registerManagedChild(child);
  const ready = Promise.withResolvers<void>();
  const prepared = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  let becameReady = false;
  let arrangementSent = false;
  let becamePrepared = false;
  let reportedCompletion = false;
  let stopping = false;
  let preparedTimer: ReturnType<typeof setTimeout> | undefined;

  const readyTimer = setTimeout(() => {
    ready.reject(new Error(`client '${options.username}' did not become ready within ${(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS) / 1000}s`));
  }, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);

  const output = createInterface({ input: child.stdout });
  output.on("line", (line) => {
    let event;
    try {
      event = parseClientEvent(line);
    } catch {
      options.log(`client '${options.username}' stdout: ${line}`);
      return;
    }
    switch (event.type) {
      case "ready":
        if (!becameReady) {
          becameReady = true;
          clearTimeout(readyTimer);
          ready.resolve();
        }
        return;
      case "prepared":
        if (!arrangementSent) {
          options.log(`client '${options.username}' ignored premature prepared report`);
          return;
        }
        if (!becamePrepared) {
          becamePrepared = true;
          if (preparedTimer) clearTimeout(preparedTimer);
          prepared.resolve();
        }
        return;
      case "log":
        options.log(`client '${options.username}': ${event.message}`);
        return;
      case "chat":
        options.onChat(event.message);
        return;
      case "finish":
        reportedCompletion = true;
        options.onCompletion(event.completion);
        return;
    }
  });

  const errors = createInterface({ input: child.stderr });
  errors.on("line", (line) => options.log(`client '${options.username}' stderr: ${line}`));
  child.stdin.on("error", (error) => {
    if (!stopping) options.log(`client '${options.username}' stdin error: ${error.message}`);
  });

  /**
   * Fail whichever handshake phase is still outstanding, and report whether
   * there was one. A client that dies mid-handshake must fail the phase the
   * trial is waiting on rather than leave it hanging — but only one phase is
   * ever outstanding, and once `stop` has resolved `prepared` deliberately,
   * nothing is owed at all.
   */
  const rejectPendingPhase = (cause: Error): boolean => {
    clearTimeout(readyTimer);
    if (preparedTimer) clearTimeout(preparedTimer);
    if (!becameReady) {
      ready.reject(cause);
      return true;
    }
    if (arrangementSent && !becamePrepared && !stopping) {
      prepared.reject(cause);
      return true;
    }
    return false;
  };

  child.once("error", (error) => {
    rejectPendingPhase(error);
    options.log(`client '${options.username}' process error: ${error.message}`);
  });
  child.once("exit", (code, signal) => {
    output.close();
    errors.close();
    const detail = `client '${options.username}' exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`;
    // A prepared client that exits cannot report an unfinished outcome later.
    // Preserve its first reported completion and keep normal teardown quiet.
    if (!rejectPendingPhase(new Error(detail)) && !stopping) {
      options.log(detail);
      if (!reportedCompletion) options.onCompletion({ status: "failed", detail });
    }
    exited.resolve();
  });

  send(child, {
    type: "init",
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    host: options.host,
    port: options.port,
    username: options.username,
    version: options.version,
    scenario: options.scenario,
  });

  return {
    ready: ready.promise,
    prepared: prepared.promise,
    arranged() {
      if (arrangementSent) return;
      arrangementSent = true;
      preparedTimer = setTimeout(() => {
        prepared.reject(
          new Error(
            `client '${options.username}' did not observe scenario arrangement within ${(options.preparedTimeoutMs ?? DEFAULT_PREPARED_TIMEOUT_MS) / 1000}s`,
          ),
        );
      }, options.preparedTimeoutMs ?? DEFAULT_PREPARED_TIMEOUT_MS);
      send(child, { type: "arranged" });
    },
    start() {
      send(child, { type: "start" });
    },
    /**
     * Bring the client down, escalating until it is actually gone.
     *
     * Every wait here is bounded, because a wedged client used to be able to
     * hang the whole harness. It would ignore the stop handoff, ignore the
     * SIGTERM that followed, and the trial would then wait forever on an exit
     * that was never coming — with the goal already decided and the server
     * still running. A trial that has finished judging must always be able to
     * finish.
     */
    async stop(reason: string) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      stopping = true;
      if (preparedTimer) clearTimeout(preparedTimer);
      prepared.resolve();
      send(child, { type: "stop", reason });
      if (await settledWithin(exited.promise, STOP_GRACE_MS)) return;

      child.kill();
      if (await settledWithin(exited.promise, SIGNAL_GRACE_MS)) return;

      // SIGTERM is advisory, and a client blocked in a native call can miss it
      // entirely.
      child.kill("SIGKILL");
      if (await settledWithin(exited.promise, SIGNAL_GRACE_MS)) return;

      // Nothing left to escalate to. Detach the pipes so an abandoned child
      // cannot hold the harness open, and let the trial finish reporting.
      options.log(`client '${options.username}' ignored SIGKILL; abandoning it`);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    },
  };
}

function spawnClient(client: ClientCommandSpec, artifactsDirectory: string): ChildProcessWithoutNullStreams {
  return spawn(client.command, client.args, {
    cwd: client.cwd,
    env: { ...process.env, ...client.env, MINE_LABS_ARTIFACTS_DIR: artifactsDirectory },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function send(child: ChildProcessWithoutNullStreams, command: ClientCommand): void {
  if (!child.stdin.destroyed) child.stdin.write(encodeClientMessage(command));
}
