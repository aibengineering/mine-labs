/**
 * Public API for writing clients (`import ... from "mine-labs/client"`).
 *
 * Separate from the main entry point because the audience is different: this is
 * for the program *being tested*, which needs the protocol and the Node helper
 * but has no business starting servers or running suites. The scenario types
 * are re-exported here so a client can read its own scenario in a typed way
 * without depending on the harness half of the package.
 */

export {
  CLIENT_PROTOCOL_VERSION,
  encodeClientMessage,
  parseClientCommand,
  parseClientEvent,
  type ClientCommand,
  type ClientCompletion,
  type ClientEvent,
} from "./protocol.js";
export { runNodeClient, type NodeClientSession } from "./node.js";
export type { PlayerSpec, ScenarioDefinition } from "../scenario/schema.js";
