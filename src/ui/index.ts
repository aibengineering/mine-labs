/**
 * Public API for the optional UI layer (`import ... from "mine-labs/ui"`).
 *
 * A separate entry point because this whole layer is optional: the harness runs
 * headless without it, and anyone embedding Mine Labs should be able to ignore
 * the in-game observation stack entirely rather than pull an HTTP server and a
 * Java mod build into their dependency graph.
 */

export {
  UiServer,
  DEFAULT_UI_PORT,
  startUiServer,
  type UiServerOptions,
  type UiActiveTrial,
  type UiResult,
  type UiSnapshot,
} from "./server.js";
export { buildClientMod, type ClientModBuild } from "./build.js";
export { openLab } from "./open.js";
