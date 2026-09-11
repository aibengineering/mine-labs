import { runNodeClient } from "../node.ts";

await runNodeClient(async (session) => {
  session.log(`connected as ${session.username}`);
  session.log(`received launch config: ${Object.hasOwn(session.scenario, "client")}`);
  if (process.env.MINE_LABS_TEST_ENV) session.log(`environment: ${process.env.MINE_LABS_TEST_ENV}`);
  session.log(`artifacts: ${process.env.MINE_LABS_ARTIFACTS_DIR}`);
  session.chat("fixture chat");
  session.ready();
  await session.arranged;
  session.log("observed scenario arrangement");
  session.prepared();
  await session.start;
  if (session.signal.aborted) return;
  session.finish({ status: "succeeded", detail: "fixture complete" });
});
