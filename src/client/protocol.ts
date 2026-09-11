/**
 * The contract between Mine Labs and a scenario client, in both directions.
 *
 * Clients are the thing under test and may be written in any language, so the
 * interface between harness and client is newline-delimited JSON over
 * stdin/stdout - the one IPC mechanism every language has without a library.
 * This module is the single definition of that wire format, and both sides
 * parse it through the same schemas so a malformed message is caught at the
 * boundary rather than halfway through a trial.
 *
 * The command sequence encodes the handshake the harness depends on: `init`
 * (who you are and what the scenario is), `arranged` (the fixture is now
 * built - look at it), `start` (measurement begins now), `stop`. The version
 * field is checked so an out-of-date client fails immediately with a clear
 * message instead of behaving subtly wrongly.
 */

import { z } from "zod";
import { scenarioDefinitionSchema, type ScenarioDefinition } from "../scenario/schema.js";

export const CLIENT_PROTOCOL_VERSION = 2;

export type ClientCompletion =
  | { status: "succeeded"; detail?: string }
  | { status: "failed"; detail: string };

export type ClientCommand =
  | {
      type: "init";
      protocolVersion: typeof CLIENT_PROTOCOL_VERSION;
      host: string;
      port: number;
      username: string;
      version: string;
      scenario: ScenarioDefinition;
    }
  | { type: "arranged" }
  | { type: "start" }
  | { type: "stop"; reason: string };

export type ClientEvent =
  | { type: "ready" }
  | { type: "prepared" }
  | { type: "log"; message: string }
  | { type: "chat"; message: string }
  | { type: "finish"; completion: ClientCompletion };

const completionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), detail: z.string().optional() }),
  z.object({ status: z.literal("failed"), detail: z.string() }),
]);

const clientCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("init"),
    protocolVersion: z.literal(CLIENT_PROTOCOL_VERSION),
    host: z.string(),
    port: z.number().int().positive(),
    username: z.string(),
    version: z.string(),
    scenario: scenarioDefinitionSchema,
  }),
  z.object({ type: z.literal("arranged") }),
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("stop"), reason: z.string() }),
]);

const clientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("prepared") }),
  z.object({ type: z.literal("log"), message: z.string() }),
  z.object({ type: z.literal("chat"), message: z.string() }),
  z.object({ type: z.literal("finish"), completion: completionSchema }),
]);

export function encodeClientMessage(message: ClientCommand | ClientEvent): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseClientCommand(line: string): ClientCommand {
  return clientCommandSchema.parse(JSON.parse(line));
}

export function parseClientEvent(line: string): ClientEvent {
  return clientEventSchema.parse(JSON.parse(line));
}
