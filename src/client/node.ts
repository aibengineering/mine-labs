/**
 * Optional convenience layer for writing a scenario client with Node APIs under Bun.
 *
 * Nothing in Mine Labs requires this - a client only has to read and write the
 * JSON lines described in `protocol.ts`, in whatever language. But most first
 * clients are written in Node, and doing the stdio plumbing by hand is both
 * repetitive and easy to get subtly wrong (missing the arranged/start
 * distinction, reporting completion twice, ignoring a stop request).
 *
 * So this presents the same protocol as awaitable promises and an
 * `AbortSignal`, and enforces the parts that must not be got wrong: `ready`,
 * `prepared` and `finish` are idempotent, and a thrown error is reported as a
 * failed completion rather than a client that simply stops responding.
 */

import { createInterface } from "node:readline";
import {
  encodeClientMessage,
  parseClientCommand,
  type ClientCommand,
  type ClientCompletion,
  type ClientEvent,
} from "./protocol.js";
import type { ScenarioDefinition } from "../scenario/schema.js";

export interface NodeClientSession {
  host: string;
  port: number;
  username: string;
  version: string;
  scenario: ScenarioDefinition;
  arranged: Promise<void>;
  start: Promise<void>;
  signal: AbortSignal;
  ready(): void;
  prepared(): void;
  log(message: string): void;
  chat(message: string): void;
  finish(completion: ClientCompletion): void;
}

/** Optional Bun convenience API using Node-compatible streams for Mine Labs' language-neutral stdio protocol. */
export async function runNodeClient(client: (session: NodeClientSession) => void | Promise<void>): Promise<void> {
  const input = createInterface({ input: process.stdin });
  const initialized = Promise.withResolvers<Extract<ClientCommand, { type: "init" }>>();
  const arranged = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const cancellation = new AbortController();
  let ready = false;
  let prepared = false;
  let finished = false;

  const stop = (reason: string): void => {
    if (!cancellation.signal.aborted) cancellation.abort(reason);
    arranged.resolve();
    started.resolve();
    input.close();
  };

  input.on("line", (line) => {
    let command: ClientCommand;
    try {
      command = parseClientCommand(line);
    } catch (cause) {
      send({
        type: "log",
        message: `ignored invalid Mine Labs message: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      return;
    }

    if (command.type === "init") initialized.resolve(command);
    else if (command.type === "arranged") arranged.resolve();
    else if (command.type === "start") started.resolve();
    else stop(command.reason);
  });
  input.once("close", () => stop("Mine Labs input closed"));

  const init = await initialized.promise;
  const session: NodeClientSession = {
    host: init.host,
    port: init.port,
    username: init.username,
    version: init.version,
    scenario: init.scenario,
    arranged: arranged.promise,
    start: started.promise,
    signal: cancellation.signal,
    ready: () => {
      if (ready) return;
      ready = true;
      send({ type: "ready" });
    },
    prepared: () => {
      if (prepared) return;
      prepared = true;
      send({ type: "prepared" });
    },
    log: (message) => send({ type: "log", message }),
    chat: (message) => send({ type: "chat", message }),
    finish: (completion) => {
      if (finished) return;
      finished = true;
      send({ type: "finish", completion });
    },
  };

  try {
    await client(session);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    session.finish({ status: "failed", detail });
    throw cause;
  }
}

function send(event: ClientEvent): void {
  process.stdout.write(encodeClientMessage(event));
}
