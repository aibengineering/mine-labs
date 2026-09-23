import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadRunCatalog } from "../scenario/catalog.js";
import { inspectScenario } from "../scenario/inspection.js";
import { SessionController } from "../session/controller.js";
import { runSession } from "../session/run.js";
import { DEFAULT_UI_PORT, startUiServer, type UiRemoteClient } from "./server.js";
import { buildRemoteClientMod, launchSpectatorClient, SPECTATOR_USERNAME } from "./launch.js";
import { tailscaleAddress } from "./tailscale.js";
import { collectSpectatorSetup, spectatorSetupKey } from "./spectator-mods.js";

/**
 * One owned lifetime for the catalog API, development client, and replaceable scenario servers.
 *
 * In Tailscale remote mode the lab launches no client. It serves this machine's
 * tailnet address instead and waits for a player's own Minecraft, such as a
 * phone launcher, to connect with the Mine Labs mod.
 */
export async function openLab(options: {
  paths: string[]; rootDir: string; uiPort?: number; preferPort?: number;
  jobs?: number; isolated?: boolean; repeat?: number; keepRuns?: number;
  tailscale?: boolean;
  signal?: AbortSignal; log: (message: string) => void;
}): Promise<void> {
  const catalog = await loadRunCatalog(options.paths, SPECTATOR_USERNAME);
  const spectatorSetup = await collectSpectatorSetup(catalog.scenarios.map(({ scenario }) => scenario));
  const rootDir = resolve(options.rootDir);
  await mkdir(rootDir, { recursive: true });
  const host = options.tailscale ? tailscaleAddress() : undefined;
  const remote: UiRemoteClient | undefined = options.tailscale ? {
    downloads: [
      { name: "mine-labs-ui.jar", path: await buildRemoteClientMod({ rootDir, log: options.log }) },
      ...spectatorSetup.mods.map(mod => ({ name: `mine-labs-spectator-${mod.id}.jar`, path: mod.path })),
    ],
    clientProperties: spectatorSetup.systemProperties,
  } : undefined;
  const controller = new SessionController();
  controller.setJobs(options.jobs ?? 1);
  controller.setContinuous(false);
  if (options.repeat === Number.POSITIVE_INFINITY) {
    controller.setContinuous(true);
    controller.selectCategory(undefined); // --repeat forever explicitly starts the catalog.
  }
  else if (options.repeat !== undefined) controller.queueBatch(catalog.scenarios.length * options.repeat);
  else if (catalog.initial) controller.selectScenario(catalog.initial);
  const stop = (): void => controller.stop();
  let client: Awaited<ReturnType<typeof launchSpectatorClient>> | undefined;
  let clientFailure: unknown;
  const ui = await startUiServer({
    // A remote client keeps its lab address between sessions, so remote mode keeps the port too.
    controller, rootDir, port: options.uiPort ?? (remote ? DEFAULT_UI_PORT : 0), host, remote, log: options.log, maxJobs: Math.max(8, options.jobs ?? 1),
    refreshCatalog: async () => {
      // Validate the whole replacement before publishing it. Active trials retain
      // their original entry; the scheduler reads this array on its next claim.
      const refreshed = await loadRunCatalog(options.paths, SPECTATOR_USERNAME);
      const nextSetup = await collectSpectatorSetup(refreshed.scenarios.map(({ scenario }) => scenario));
      if (spectatorSetupKey(nextSetup) !== spectatorSetupKey(spectatorSetup)) {
        throw new Error("Spectator mods or JVM properties changed. Restart Mine Labs with --spectator to load them.");
      }
      catalog.scenarios.splice(0, catalog.scenarios.length, ...refreshed.scenarios);
      return catalog.scenarios.map(({ id, scenario, category }) => ({ name: id ?? scenario.name ?? "scenario", category: category ?? "other", inspection: inspectScenario(id ?? scenario.name ?? "scenario", scenario) }));
    },
  });
  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    options.signal?.throwIfAborted();
    let spectator: { readonly username: string } = { username: SPECTATOR_USERNAME };
    if (remote) {
      options.log(`Tailscale remote mode: open ${ui.url} on your device for the mods, then enter that address in Minecraft's Mine Labs screen`);
      const name = await ui.waitForSpectatorName(options.signal);
      options.log(`Mine Labs client connected as ${name}`);
      // Each new world reads the latest name, so switching devices takes effect on the next world.
      spectator = { get username() { return ui.spectatorName ?? name; } };
    } else {
      client = await launchSpectatorClient({ rootDir, uiPort: ui.port, log: options.log, setup: spectatorSetup });
      void client.closed.catch((error: unknown) => { clientFailure = error; }).finally(stop);
    }
    await runSession({
      scenarios: catalog.scenarios, rootDir, spectator, host,
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
