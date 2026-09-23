import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { type RunResult } from "./trial/run.js";
import { runSession } from "./session/run.js";
import { runVerification } from "./session/verification.js";
import { SessionController } from "./session/controller.js";
import { reapManagedChildren } from "./process/children.js";
import { buildClientMod } from "./ui/build.js";
import { formatDuration } from "./util/text.js";
import { writeTextFile } from "./util/fs.js";
import { EXAMPLE_CLIENT, EXAMPLE_SCENARIO } from "./cli/templates.js";
import { openLab } from "./ui/open.js";
import { loadScenarioCatalog, loadRunCatalog } from "./scenario/catalog.js";

function makeLog(prefix = ""): (s: string) => void {
  return (s) =>
    console.log(pc.dim(`${new Date().toLocaleTimeString()} `) + (prefix ? pc.cyan(prefix + " ") : "") + s);
}

function printResult(result: RunResult): void {
  const line = {
    pass: pc.green("PASS"),
    fail: pc.red("FAIL"),
    timeout: pc.yellow("TIMEOUT"),
    error: pc.magenta("ERROR"),
    cancelled: pc.gray("CANCELLED"),
  }[result.outcome];
  console.log(`\n${line}  ${pc.bold(result.scenario)}  ${pc.dim(formatDuration(result.elapsedMs))}`);
  if (result.error) console.log(pc.red(result.error));
  console.log(pc.dim(`  goal: ${result.goal.detail}`));
}

export async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program.name("mine-labs").description("language-neutral Minecraft scenario harness").version("0.1.0");

  program
    .command("init")
    .description("scaffold an example scenario + client in the current directory")
    .action(async () => {
      const log = makeLog("init");
      const files: [string, string][] = [
        ["scenarios/zombie-hunt.yaml", EXAMPLE_SCENARIO],
        ["clients/hunter.js", EXAMPLE_CLIENT],
      ];
      for (const [p, content] of files) {
        if (existsSync(p)) {
          log(`skip ${p} (exists)`);
          continue;
        }
        await writeTextFile(p, content);
        log(`created ${p}`);
      }
      console.log("\nThe generated bot uses Mineflayer and Pathfinder. Install them in this project:");
      console.log(`  ${pc.cyan("bun add mineflayer mineflayer-pathfinder")}`);
      console.log("These are example bot dependencies; your own client chooses its dependencies.");
      console.log(`\nnext: ${pc.cyan("bun run mine-labs run --spectator scenarios")}`);
    });

  program.command("run [scenarios...]")
    .description("run files or folders; add --spectator for the Mine Labs dashboard")
    .option("--spectator", "open the managed NeoForge client")
    .option("--tailscale", "Tailscale remote mode: serve the dashboard on this machine's tailnet address for your own Minecraft client (such as a phone launcher) instead of opening one")
    .option("-j, --jobs <n>", "parallel scenario workers", positiveInteger, 1)
    .option("-r, --repeat <n>", "number of suite passes, or forever", repeatCount, 1)
    .option("--isolated", "always create fresh worlds instead of using safe resets")
    .option("-p, --port <port>", "preferred server port", portNumber)
    .option("-o, --out <dir>", "session evidence root", ".mine-labs")
    .option("--ui-port <port>", "client control API port (default: automatic)", portNumber)
    .option("--keep-runs <n>", "number of trial results to retain", nonnegativeInteger, 100)
    .action(async (files: string[], opts, command: Command) => {
      const controller = new SessionController();
      const log = makeLog("run");
      let force: ReturnType<typeof setTimeout> | undefined;
      const stop = (): void => {
        if (controller.signal.aborted) { reapManagedChildren(); process.exit(130); }
        controller.stop();
        force = setTimeout(() => { reapManagedChildren(); process.exit(130); }, 8000);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      try {
        if (opts.spectator || opts.tailscale || files.length === 0) {
          const clientRoot = command.getOptionValueSource("out") === "default" ? resolve(".mine-labs/open") : resolve(opts.out);
          await openLab({ paths: files.length ? files : ["scenarios"], rootDir: clientRoot,
            preferPort: opts.port, uiPort: opts.uiPort, jobs: opts.jobs, isolated: opts.isolated,
            repeat: command.getOptionValueSource("repeat") === "cli" ? opts.repeat : undefined,
            keepRuns: opts.keepRuns, tailscale: opts.tailscale,
            signal: controller.signal, log });
        } else {
          const catalog = await loadRunCatalog(files);
          const summary = await runSession({ scenarios: catalog.scenarios, rootDir: resolve(opts.out),
            jobs: opts.jobs, cycles: opts.repeat, isolated: opts.isolated, keepRuns: opts.keepRuns,
            preferPort: opts.port, delayMs: 0, controller, log,
            onResult: (result, context) => { printResult(result); console.log("results: " + join(context.runDir, "results.json")); },
          });
          console.log("session: " + summary.passed + "/" + summary.runs + " passed, " + summary.failed + " failed, " + summary.cancelled + " cancelled");
          process.exitCode = controller.signal.aborted ? 130 : summary.failed || summary.cancelled ? 1 : 0;
        }
      } finally {
        if (force) clearTimeout(force);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    });

  program
    .command("verify <scenarios...>")
    .description("verify goals in seeded natural worlds; separated locations share one server")
    .option("-j, --jobs <n>", "maximum concurrent clients per shared world", positiveInteger, 4)
    .option("-r, --repeat <n>", "repeat the suite in fresh worlds", positiveInteger, 1)
    .option("--isolated", "use one fresh server per attempt for replay or a throughput comparison")
    .option("-p, --port <port>", "preferred server port", portNumber)
    .option("-o, --out <dir>", "verification evidence root", ".mine-labs/verification")
    .action(async (files: string[], opts) => {
      const controller = new AbortController();
      const stop = (): void => controller.abort("operator request");
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      try {
        const catalog = await loadScenarioCatalog(files);
        const scenarios = catalog.scenarios.map(entry => entry.scenario);
        const rootDir = join(resolve(opts.out), new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"));
        const summary = await runVerification({
          scenarios, rootDir, mode: opts.isolated ? "isolated" : "shared", jobs: opts.jobs,
          repeat: opts.repeat, preferPort: opts.port, signal: controller.signal, log: makeLog("verify"),
        });
        const passed = summary.results.filter((result) => result.outcome === "pass").length;
        console.log(`verification: ${passed}/${summary.results.length} passed, ${summary.servers} servers, ${formatDuration(summary.elapsedMs)} wall time`);
        console.log(`evidence: ${rootDir}`);
        process.exitCode = controller.signal.aborted ? 130 : passed === summary.results.length ? 0 : 1;
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    });

  program.command("list [scenarios...]")
    .description("list runnable scenarios from files or folders (default: ./scenarios)")
    .action(async (files: string[]) => {
      const catalog = await loadRunCatalog(files.length ? files : ["scenarios"]);
      for (const { id, scenario } of catalog.scenarios) {
        console.log(`${pc.cyan(id)}${scenario.description ? "  " + pc.dim(scenario.description) : ""}`);
      }
    });
  const ui = program.command("ui").description("build the Minecraft client mod for development");
  ui.command("build")
    .description("build the NeoForge 1.21.4 client mod")
    .action(async () => {
      const result = await buildClientMod();
      console.log(pc.green(`built ${result.jar}`));
    });

  program
    .command("doctor")
    .description("show the detected Java and Bun versions")
    .action(() => {
      const java = spawnSync("java", ["-version"], { encoding: "utf8" });
      const ver = java.status === 0 ? (java.stderr + java.stdout).match(/version "([^"]+)"/)?.[1] : undefined;
      console.log(ver ? pc.green(`✓ java ${ver}`) : pc.red("✗ could not read the Java version from PATH"));
      const bunVersion = process.versions.bun;
      console.log(bunVersion ? pc.green(`✓ bun ${bunVersion}`) : pc.red("✗ Mine Labs is not running under Bun"));
    });

  await program.parseAsync(argv);
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("expected a positive integer");
  return parsed;
}

function portNumber(value: string): number {
  const parsed = positiveInteger(value);
  if (parsed > 65_535) throw new Error("expected a port at most 65535");
  return parsed;
}

function nonnegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error("expected a nonnegative integer");
  return parsed;
}

function repeatCount(value: string): number {
  return value === "forever" ? Number.POSITIVE_INFINITY : positiveInteger(value);
}
