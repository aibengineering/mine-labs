/**
 * A client that becomes prepared and then stops listening.
 *
 * It speaks the protocol only far enough to be started, then ignores the stop
 * handoff entirely and holds an open timer so the process will not exit on its
 * own. This is the shape of a wedged scenario client, which the harness must
 * be able to bring down without waiting forever.
 */
import { createInterface } from "node:readline";

const output = createInterface({ input: process.stdin });
output.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  // Answer both preparation phases so the harness can start the client, then
  // go deaf: no reaction to `start`, and none to `stop`.
  if (message.type === "init") process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);
  if (message.type === "arranged") process.stdout.write(`${JSON.stringify({ type: "prepared" })}\n`);
});

setInterval(() => {}, 1_000);
