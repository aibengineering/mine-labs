import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadRunCatalog } from "../scenario/catalog.js";
import { inspectScenario } from "../scenario/inspection.js";
import { SessionController } from "../session/controller.js";
import { runSession } from "../session/run.js";
import { startUiServer } from "./server.js";
import { launchSpectatorClient, SPECTATOR_USERNAME } from "./launch.js";

/** One owned lifetime for the catalog API, development client, and replaceable scenario servers. */
export async function openLab(options: {
  paths: string[]; rootDir: string; uiPort?: number; preferPort?: number;
  jobs?: number; isolated?: boolean; repeat?: number; keepRuns?: number;
  signal?: AbortSignal; log: (message: string) => void;
}): Promise<void> {
  const catalog = await loadRunCatalog(options.paths, SPECTATOR_USERNAME);
  const rootDir = resolve(options.rootDir);
  await mkdir(rootDir, { recursive: true });
  const controller = new SessionController();
  controller.setJobs(options.jobs ?? 1);
  controller.setContinuous(false);
  if (options.repeat === Number.POSITIVE_INFINITY) controller.setContinuous(true);
  else if (options.repeat !== undefined) controller.queueBatch(catalog.scenarios.length * options.repeat);
  else if (catalog.initial) controller.selectScenario(catalog.initial);
  const stop = (): void => controller.stop();
  let client: Awaited<ReturnType<typeof launchSpectatorClient>> | undefined;
  let clientFailure: unknown;
  const ui = await startUiServer({
    controller, rootDir, port: options.uiPort ?? 0, log: options.log, maxJobs: Math.max(8, options.jobs ?? 1),
    refreshCatalog: async () => {
      // Validate the whole replacement before publishing it. Active trials retain
      // their original entry; the scheduler reads this array on its next claim.
      const refreshed = await loadRunCatalog(options.paths, SPECTATOR_USERNAME);
      catalog.scenarios.splice(0, catalog.scenarios.length, ...refreshed.scenarios);
      return catalog.scenarios.map(({ id, scenario, category }) => ({ name: id ?? scenario.name ?? "scenario", category: category ?? "other", inspection: inspectScenario(id ?? scenario.name ?? "scenario", scenario) }));
    },
  });
  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    options.signal?.throwIfAborted();
    client = await launchSpectatorClient({ rootDir, uiPort: ui.port, log: options.log });
    void client.closed.catch((error: unknown) => { clientFailure = error; }).finally(stop);
    await runSession({
      scenarios: catalog.scenarios, rootDir, spectator: { username: SPECTATOR_USERNAME },
      jobs: options.jobs, maxJobs: Math.max(8, options.jobs ?? 1), isolated: options.isolated, keepRuns: options.keepRuns,
      controller, observer: ui, log: options.log, preferPort: options.preferPort, delayMs: 0,
    });
    if (clientFailure) throw clientFailure;
  } finally {
    controller.stop();
    options.signal?.removeEventListener("abort", stop);
    try { await client?.stop(); } finally { await ui.close(); }
  }
}
