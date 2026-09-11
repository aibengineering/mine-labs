/**
 * Process entry point for the `mine-labs` command.
 *
 * Deliberately tiny and separate from `cli.ts`: everything else in `src/` is
 * importable as a library, and a library must not decide to call
 * `process.exit`. This file is the one place allowed to, so the CLI and the
 * published package can share all their code without the package terminating
 * its host process.
 */

import { main } from "./cli.js";

main(process.argv).catch((e) => {
  console.error(String(e.stack ?? e));
  process.exit(1);
});
