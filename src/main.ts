/**
 * Process entry point for the `mine-labs` command.
 *
 * Deliberately tiny and separate from `cli.ts`: everything else in `src/` is
 * importable as a library, and a library must not decide to call
 * `process.exit`. Only this file and the `run` command's signal handler in
 * `cli.ts` (a second Ctrl+C, or a stop that has not finished within eight
 * seconds) are allowed to, so the CLI and the published package can share all
 * their code without the package terminating its host process.
 */

import { main } from "./cli.js";

main(process.argv).catch((e) => {
  console.error(String(e.stack ?? e));
  process.exit(1);
});
