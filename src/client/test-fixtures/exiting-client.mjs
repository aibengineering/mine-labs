import { createInterface } from "node:readline";
const mode = process.argv[2];
const lines = createInterface({ input: process.stdin });
const send = (event) => process.stdout.write(JSON.stringify(event) + "\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "init") send({ type: "ready" });
  if (message.type === "arranged") send({ type: "prepared" });
  if (message.type === "stop") process.exit(0);
  if (message.type === "start") {
    if (mode === "finished") {
      process.stdout.write(
        JSON.stringify({
          type: "finish",
          completion: { status: "succeeded", detail: "observed outcome" },
        }) + "\n",
        () => process.exit(23),
      );
    } else process.exit(Number(mode));
  }
});
