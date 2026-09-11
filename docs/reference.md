# Mine Labs reference

For the first run, see the [README](../README.md).

## Scenario format

```yaml
name: zombie-hunt
description: A single zombie spawns; the client player must kill it.

minecraft:
  version: "1.21.4"

world:
  type: flat            # flat (superflat) | default (normal terrain; set a seed!)
  # dimension: overworld  # overworld | the_nether | the_end: every coordinate in this file is here
  # seed: 12345         # fix the seed for reproducible default worlds
  # time: noon
  gamerules:
    doMobSpawning: false
    keepInventory: true

geometry:               # one-shot world edits (run over rcon before client players join)
  - fill: { block: stone_bricks, from: [-4, -59, -4], to: [4, -59, 4], mode: replace }
  - setblock: { at: [12, -60, 12], block: gold_block }
  - run: "/setworldspawn 0 -59 0"    # or any raw command

reset:                  # optional: additional cleanup before arena restoration.
  - "fill -16 -59 -16 16 -40 16 air"   # run before geometry, and again on the way out

entities:
  - type: zombie
    pos: [4, -59, 4]
    nbt: "{PersistenceRequired:1b}"   # raw SNBT appended to /summon

tick:                   # optional: commands executed EVERY tick via generated datapack
  - "execute as @e[type=zombie] run particle minecraft:flame ~ ~1 ~ 0 0 0 0 1"

players:
  - name: hunter        # 3-16 chars of [A-Za-z0-9_]
    pos: [0, -59, 0]
    # health: 11        # optional: start wounded, out of 20 (applied after cleanup)
    inventory:          # optional: provisioned after cleanup, before ctx.start
      - { item: iron_sword, count: 1 }

client:
  command: bun
  args: ["../clients/hunter.js"]

goal:
  kind: kill
  target: zombie
  timeout: 90           # seconds before TIMEOUT
```

### Dimensions

Every coordinate in a scenario is in `world.dimension`, which defaults to the
overworld. Mine Labs points each world edit, entity, `setup`, `reset` and
`tick` command, block goal and player teleport at that dimension over rcon,
pins and snapshots the arena there, and clamps the arena to that dimension's
build height. Player goals such as `reach` and `entityDistance` follow the
named player wherever it is. A player joins in the overworld, so a scenario
anywhere else must give every player a `pos`; the loader refuses one that
does not. A driver never has to move itself: by the time it is told `start`,
its player is standing at its declared position in the declared dimension.

### Reusable scenario templates

Scenarios that share an arena can move only the world setup into a separate
template file:

```yaml
# templates/stone-arena.yaml
world:
  type: flat
  gamerules: { doMobSpawning: false }
reset:
  - "fill -16 -59 -16 16 -40 16 air"
geometry:
  - fill: { block: stone_bricks, from: [-4, -59, -4], to: [4, -59, 4], mode: replace }
```

```yaml
# scenarios/zombie-hunt.yaml
template: ../templates/stone-arena.yaml
entities:
  - { type: zombie, pos: [4, -58, 4] }
client: { command: bun, args: ["../clients/hunter.js"] }
goal: { kind: kill, target: zombie }
```

A template may define any scenario field except `template`. Fields defined in
the referring scenario override fields from the template. Template paths and
client paths are both relative to the scenario file. Templates are deliberately
one level deep and should live outside `scenarios/` so catalogue discovery does
not treat them as runnable trials.

### Goal kinds

| kind        | fields                          | passes when                                    |
|-------------|---------------------------------|------------------------------------------------|
| `reach`     | `pos`, `radius?` (default 2)    | the player is within radius of pos             |
| `kill`      | `target`                        | entity type existed, now count == 0            |
| `entityCount` | `entity`, `min?`, `max?`      | live entity count within [min, max]            |
| `hasItem`   | `item`, `count?` (default 1)    | player's inventory holds count of item         |
| `blockAt`   | `pos`, `block`                  | block at pos matches the requested block       |
| `health`    | `health?` (default 1)           | player health >= threshold                     |
| `chat`      | `contains` (string or list)     | every string seen in chat/messages             |
| `completion` | —                              | client process reports successful completion   |
| `survive`   | `seconds`                       | selected player, or all players, alive for N seconds |
| `all`/`any` | `goals: [...]`                  | compose child goals                            |

Leaf goals accept `who: <player name>`. It selects the player where evaluation
needs one and attributes independently observed world goals to a declared
client. Composite `all`/`any` goals do not accept `who`.

`timeout` belongs only on the top-level goal and limits settlement of the whole
trial. Unknown fields are rejected so misspelled scenario options cannot be
silently ignored.

## Client processes

Mine Labs does not create or host the tested client. It starts a process and
hands it the server connection, parsed scenario, start signal, cancellation, and
completion channel over newline-delimited JSON on stdin/stdout. The executable
can be written in Java, JavaScript, Rust, Python, or anything else that can read
and write JSON lines.

```yaml
client:
  command: java
  args: ["-jar", "./build/libs/my-bot.jar"]
  env:
    BEHAVIOR_IMPLEMENTATION: baseline
```

The command runs with the scenario file's directory as its working directory.
`env` values are merged over Mine Labs' inherited process environment and must
be strings.
Mine Labs launches one process for each entry in `players:` and sends:

```json
{"type":"init","protocolVersion":2,"host":"127.0.0.1","port":25565,"username":"hunter","version":"1.21.4","scenario":{}}
{"type":"arranged"}
{"type":"start"}
{"type":"stop","reason":"scenario finished"}
```

The client reserves stdout for protocol events:

```json
{"type":"ready"}
{"type":"prepared"}
{"type":"log","message":"scanning for zombies"}
{"type":"chat","message":"optional observed chat line"}
{"type":"finish","completion":{"status":"succeeded","detail":"optional evidence"}}
```

`ready` means the named player has joined and armed any observers it needs.
Mine Labs then clears reusable state, grants declared inventory, applies
operator status and teleports the player before sending `arranged`. Each client
observes the setup facts it depends on and replies with `prepared`. The
dimension and starting position are the scenario's to declare, not the
driver's to arrange; anything a driver must still check or settle before
measurement finishes before `prepared`, and the player stays safe while it
waits for `start`. Mine Labs sends `start` only after
every client is prepared, any spectator gate has passed, and connected operators
have been placed at the bot's viewpoint. `finish` is required only by a `completion` goal; world and player goals
are evaluated independently through RCON.

### Local human operators

Every Mine Labs server also seeds its `ops.json` from the machine-local
`$XDG_CONFIG_HOME/minelabs/config.json`, falling back to
`~/.config/minelabs/config.json` when `XDG_CONFIG_HOME` is unset. Set
`MINE_LABS_CONFIG` to use another file. Create it with your own player names:

```json
{
  "schemaVersion": 1,
  "operators": ["ExamplePlayer"]
}
```

A missing file means no extra human operators; invalid configuration reports an
error. Mine Labs does not read another package's configuration. Names in
`operators` receive Minecraft operator level 2, using the
offline-mode UUID required by Mine Labs' local servers. This is intentionally
separate from each scenario's `players[].op`: the central list is for named
humans who may join any scenario, while `players[].op` controls the launched
scenario client for that individual trial.

Those operators are also **placed into spectator mode with night vision the
moment they join**, in every session, and are
placed four blocks above and six behind the first client's prepared location,
looking down about 34 degrees, just before execution. Late arrivals receive the
same camera offset in the client's current dimension. A human arriving in the
default survival gamemode stands inside the arrangement the trial is measuring —
and in a combat fixture the mobs attack them — so a spectator is the only
sensible default. In a sealed fixture, vanilla also refuses to spawn a joining
player inside the enclosure and puts them on the roof instead, which is why the
teleport is part of it.

The switch is applied on arrival, not enforced continuously: an operator who
puts themselves back into survival is left alone until they rejoin.

### JavaScript clients under Bun

Clients can speak the JSON protocol directly. JavaScript clients running under Bun can use the optional
`runNodeClient` convenience API. The helper owns only stdin/stdout protocol
bookkeeping; the client still creates, configures, observes and closes its own
Minecraft connection.

```js
import { once } from "node:events";
import mineflayer from "mineflayer";
import { runNodeClient } from "mine-labs/client";

await runNodeClient(async (ctx) => {
  const bot = mineflayer.createBot({
    host: ctx.host,
    port: ctx.port,
    username: ctx.username,
    version: ctx.version,
    auth: "offline",
  });
  ctx.signal.addEventListener("abort", () => bot.quit(), { once: true });
  await once(bot, "spawn");
  ctx.ready();
  await ctx.arranged;
  // Observe any client-visible setup this behavior depends on before replying.
  ctx.prepared();
  await ctx.start;
  if (ctx.signal.aborted) return;

  ctx.log("doing things…");
  ctx.finish({ status: "succeeded" });
});
```

- The client calls `ready()` after its named player joins and its setup observers
  are armed, awaits `arranged`, and calls `prepared()` only after the declared
  client-visible setup has landed. It then awaits `start` before invoking the
  behavior under test.
- Mine Labs observes only the server facts required by the declared goal.
- `ctx.finish({ status: "succeeded" })` satisfies a `completion` goal; `{ status:
  "failed", detail }` fails it immediately.
- `ctx.signal` aborts when an operator skips, changes or stops the active trial.

## Programmatic use

```ts
import { loadScenario, runScenario } from "mine-labs";

const scenario = await loadScenario("scenarios/zombie-hunt.yaml");
const result = await runScenario({
  scenario,
  runDir: ".mine-labs/runs/custom",
  log: console.log,
});
console.log(result.outcome, result.goal);
```

`RunResult` carries the outcome, elapsed time, evaluated goal evidence, an optional error, and the game port used by the run. Client-specific metrics and diagnostics belong to the client.

## CLI

One command runs scenarios for agents and opens the client experience:

```bash
mine-labs run scenarios/example.yaml
mine-labs run scenarios/flat --jobs 4 --repeat 10
mine-labs run scenarios/flat --jobs 4 --repeat forever
mine-labs run scenarios --client
mine-labs run scenarios/example.yaml --client
```

Files and folders run headlessly once by default. `--repeat` counts complete
passes over the supplied catalog, shared across the parallel workers. `--client`
opens the bundled NeoForge dashboard; without a path, `run` opens `./scenarios`.
A folder opens the selector; a single file starts immediately. An explicit
`--repeat N` with `--client` queues that many passes and then pauses for inspection.

The dashboard has **Keep running**, **Repeat: ONE/FOLDER**, and **Parallel**
controls. With Keep running off, selecting one scenario runs one copy per
configured worker, while Run folder visits each scenario once. With it on,
the selected scenario or folder repeats until paused. Parallelism can be changed
while idle. The camera follows worker 1; other workers continue independently,
and all results appear in the same dashboard. Return to Labs cancels the active
batch and closes its worlds while leaving the catalog open.

### Preparing the next observed scenario

While worker 1 runs in client mode, Mine Labs prepares one predicted successor
on a separate, fresh server: boot, chunk loading, and world setup.
It freezes world ticking before applying setup commands. Scenario
tick scripts and declared entities activate only at the start boundary. The
prepared server stays frozen until selected, its bots have joined and completed
their preparation handshake, and the named observer has joined
and been placed; Mine Labs then unfreezes it and sends the clients `start`.
There is no fixed three-second observer delay in managed client mode.

Vanilla tick freeze excludes players. Bots therefore join only after selection,
so their health, air, effects, and external-process timers cannot age during
standby. Clients still keep their players safe during the final handshake and
wait for `start` before beginning their behavior.

Lookahead follows the remaining folder batch, repeat mode, and cycle bound
without consuming a trial. Selection, catalog, or scheduling changes discard
stale preparation. With parallel workers, the prediction is refreshed after
their claims and checked again at handoff. If preparation is still in progress,
the selected trial waits for it. Failed speculation is retried when selected.
Returning to Labs or stopping disposes of both observed servers and their bots.
This uses at most one extra server beyond the configured worker count.

Preparation has no result until selected. Its logs and artifacts are copied
into that trial's evidence directory after the clients stop; discarded
speculation does not affect run counts or history. `elapsedMs` includes standby
waiting; `runtimeMs` measures only execution after `start`.

### Automatic world reuse

Headless workers and unobserved parallel workers own a server and use the arena snapshot/reset machinery
when both scenarios declare a reset and absolute player positions, and their
arena fits the force-load limit. Minecraft version, world type, seed, structures,
difficulty, spawn, and gamerules must match. Time is reapplied for each scenario.
The observed worker uses the fresh-server lookahead described above.

The finished world remains available for inspection. When the next scenario is
selected, Mine Labs disables the previous tick function, clears its entities,
replays its reset, restores the original arena blocks, and resets player state.
It then arranges the next scenario. Arena changes must stay within the declared
fixture's snapshot region; arbitrary driver edits outside that region are not
a reset contract. Generated-terrain scenarios without such a contract get fresh
worlds. A reset failure discards the server and prepares a fresh one automatically.

Use `--isolated` when every attempt must have a fresh world, including timing
comparisons. Parallel runs contend for host resources; use one worker for those
comparisons. The server JAR and libraries are cached regardless of reuse.

### Evidence and other commands

`--out` names the evidence root. Each trial has its own `runs/<id>/` directory
containing `results.json`, `server.log`, and client-owned artifacts.
Worker worlds live separately under `servers/<session-id>/`; result retention
cannot delete a world being inspected. `--keep-runs` bounds retained results.
The headless command exits nonzero on a failed, timed-out, cancelled, or errored run.
Ctrl+C cancels and releases the session's child processes and ports.

| Command | Purpose |
| --- | --- |
| `mine-labs init` | Create an example YAML and client |
| `mine-labs list [paths...]` | List runnable entries recursively; defaults to `./scenarios` |
| `mine-labs verify <paths...> --jobs N` | Specialised shared-location throughput benchmark |
| `mine-labs doctor` | Show Java from `PATH` and the running Bun version |
| `mine-labs ui build` | Build the client mod for development |

Verification manifests can also be opened or run with `run`; their locations
become individual catalog entries and use independent worlds. The `verify`
benchmark retains its deliberate sharing of separated locations on one seed.

## Minecraft client UI

`run --client` owns the NeoForge client and a loopback-only control API on an
automatically allocated port (`--ui-port` overrides it). Closing the client
stops the session. F10 opens the dashboard from the world or Minecraft menus.
Search, folder selection, Refresh, scenario inspection, and retained results
remain available between runs. A stable connection ID identifies a world, so
the observer reconnects automatically when the next selected server is prepared.



## Natural-world verification

Verification scenarios declare one seed, one player setup, one client script, one
goal, and several absolute spawn locations. Mine Labs expands the locations into
separate attempts with unique player names, deadlines, goal observations, logs and
results. A failed client does not stop the other clients.

```yaml
name: collect-obsidian
verification:
  radius: 256
  locations:
    - [8.5, 64, -19.5]
    - [-807.5, 114, 800.5]
    - [1608.5, 75, 1600.5]
world:
  type: default
  seed: 8675309
  difficulty: peaceful
  time: noon
  gamerules: { doDaylightCycle: false, doMobSpawning: false }
players:
  - name: Collector
    inventory:
      - { item: diamond_pickaxe, count: 1 }
      - { item: water_bucket, count: 1 }
client: { command: bun, args: [./collect-obsidian.ts] }
goal:
  kind: all
  timeout: 900
  goals:
    - { kind: hasItem, item: obsidian, count: 10 }
    - { kind: completion }
```

```bash
mine-labs verify scenarios/verification --jobs 4
mine-labs verify scenarios/verification --jobs 4 --repeat 2
# Identical inputs, separate servers: replay or measure the throughput difference.
mine-labs verify scenarios/verification --jobs 4 --isolated
```

`jobs` limits clients per shared server, or concurrent servers with `--isolated`.
Compatible attempts share a batch only when their Minecraft version, seed and
world settings match and their travel envelopes do not overlap. Each batch gets
a fresh world; repeats and overlapping locations never inherit previously mined
terrain. Different seeds require different batches, run sequentially in shared
mode. Coordinates are never silently translated to make an attempt fit.

`radius` is the allowed horizontal distance from the declared spawn. The runner
checks it with the goal and fails a client observed outside it. Two chunks of
extra separation are required between envelopes. This is a cooperative test
boundary checked periodically, not a physical wall or a sandbox for arbitrary
client behaviour. Time, weather, sleep effects and server load remain shared.
Use isolated fixtures for tests that need independent control of those conditions.

Verification rejects geometry, summoned entities, raw setup/reset/tick commands,
operator clients and global entity/chat/block goals. Common difficulty belongs
in `world.difficulty`. Supported goals are `hasItem`, `completion`, `health`,
`survive`, `reach`, and `all`/`any` combinations. Client scripts use the identity
supplied in `init`; Mine Labs rewrites declared player names and `who` together.

Each invocation creates a timestamped evidence directory. `verification.json`
records wall time (including server startup, client preparation and shutdown),
server count and results. Each attempt retains `scenario.json`, `client.log`,
`results.json`; shared server logs and periodic `tick query`
samples live under `servers/`. Compare completed attempts per wall minute and
outcomes alongside runtime: fast failures are not successful throughput.

Generated worlds currently retain the harness's server defaults: structures and
animal spawning are disabled, and view/simulation distance is eight chunks.


### Viewing natural-world verification

Use `mine-labs run <manifest.yaml> --client`. Each surveyed location appears in the catalog; select one, run the folder, or enable Keep running.

### Client artifacts

Each client receives `MINE_LABS_ARTIFACTS_DIR`, an absolute path specific to its trial. Clients own the contents and should namespace files by player when necessary. Mine Labs retains this `artifacts/` directory beside `client.log` and the result when it removes the isolated server world. Observed client runs use a preparation directory while alive, then copy the evidence into the selected trial's result directory after the clients stop. Headless and verification clients write directly inside their trial directory.
