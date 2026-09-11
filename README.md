# Mine Labs

**Build repeatable tests for Minecraft bots, run them in a real world, and watch what happens.**

A scenario describes the world, the players, the bot program to run, and the goal
it must reach. Mine Labs starts a Minecraft Java server, prepares the scenario,
runs your bot, and records the outcome with structured results and logs.

Use it to reproduce a bug, compare bot implementations, or check that an action
still works after a change. Your bot can be written in any language; it runs as a
separate process and communicates with Mine Labs over a small JSON protocol.

## Start here

You need **Bun 1.4 or newer** and **Java 21**. The managed Minecraft client targets **Java Edition 1.21.4**.

### Install from GitHub

Mine Labs runs directly from TypeScript under Bun. No JavaScript build or
installation scripts are required.

In a new bot project:

```bash
mkdir my-minecraft-tests
cd my-minecraft-tests
bun add --dev git+https://github.com/aibengineering/mine-labs.git
bun run mine-labs init
bun add mineflayer mineflayer-pathfinder
bun run mine-labs run --client scenarios
```

After installing, you can also invoke the local CLI with Bun's package runner:

```bash
bunx --bun --no-install mine-labs --help
```

`init` creates `scenarios/zombie-hunt.yaml` and `clients/hunter.js`. The generated
bot uses Mineflayer and Pathfinder, so install those dependencies in **your bot
project**. Your own client chooses its libraries and versions. Mine Labs includes
Mineflayer only as a development dependency for its examples.

### Run from a checkout

```bash
git clone https://github.com/aibengineering/mine-labs.git
cd mine-labs
bun install --frozen-lockfile
bun run dev doctor
bun run dev run --client examples/scenarios
```

Choose **beacon-walk** or **zombie-hunt** in the dashboard to run an example.

For either setup, the first launch downloads the server and Gradle/NeoForge
dependencies and can take several minutes; later launches reuse the cache.
`doctor` reports Java from `PATH` and the running Bun version; it does not enforce
the versions above, check Node.js, or act as a pass/fail readiness check.

You must own Minecraft: Java Edition to use the managed client and agree to the
[Minecraft EULA](https://www.minecraft.net/en-us/eula). Mine Labs writes
`eula=true` when preparing a server. It is an unofficial project, not affiliated
with or approved by Mojang or Microsoft.

## The entry point: `run`

The examples below use a repository checkout (`bun run dev`). In an installed
project, use `bun run mine-labs` instead and point it at your `scenarios` folder.

With `--client`, `run` opens the dashboard. A folder lets you choose a scenario;
a single file starts that scenario. F10 opens the dashboard in-game. Inspect the
result, run it again, or select another scenario. **Return to Labs** closes the
active world and keeps the dashboard open; closing Minecraft or pressing Ctrl+C
stops the session.

Without `--client`, the same scenarios run from the terminal:

```bash
bun run dev run examples/scenarios/beacon-walk.yaml
bun run dev run examples/scenarios --jobs 2 --repeat 5
```

Use `bun run dev list examples/scenarios` to see the same runnable entries before
starting a session. `run`, `verify`, and `list` share file discovery: folders are
searched recursively for `.yaml` and `.yml` files in sorted order; JSON scenarios
must be named explicitly so result files are not picked up. Overlapping inputs
are deduplicated. Keep templates outside the scenario folders; invalid inputs
report an error before execution.

The terminal prints each outcome and results path. A completed headless session
exits with code 0 when every trial passes, or 1 if a trial fails, times out,
errors, or is cancelled. Ctrl+C exits with code 130.

In client mode, the observed worker prepares one fresh server ahead while the
current scenario runs. It freezes world ticking before setup and holds the
prepared world until that scenario is selected. Bots then join and prepare;
the observer connects once they are ready. Then
world ticking and bot execution start together. Changing the schedule discards
stale preparation; stopping closes both servers. This uses up to one extra server.

Headless workers and the other parallel workers reuse compatible, resettable
worlds. Add `--isolated` when every attempt must start in a fresh world.

## Write your own scenario

Start by editing a copy of the [beacon-walk scenario](examples/scenarios/beacon-walk.yaml)
and its [bot program](examples/clients/walker.js). The YAML connects four things:

| Part | What you specify |
| --- | --- |
| World | Terrain, seed, blocks, mobs, and game rules |
| Players | Names, starting positions, and inventory |
| Client | The command that launches your bot program |
| Goal | What counts as success, and how long the bot has |

Goals can check position, inventory, health, blocks, or entities, or wait for the
client to report completion. You can combine goals with `all` and `any`.
Mine Labs evaluates world and player goals through the server.

Client paths are relative to the scenario file. Each bot connects using the
identity supplied by Mine Labs and waits for the start signal before acting.
The examples use Mineflayer; your own client only needs to implement the
[client protocol](docs/reference.md#client-processes).

To generate another starting example in the current directory:

```bash
bun run dev init
bun run dev run --client scenarios
```

## Results and local settings

Headless runs write evidence beneath `.mine-labs/runs/`. Dashboard sessions use
`.mine-labs/open/`, including their results and managed client files. Use
`--out <directory>` to choose another location. Server downloads are cached under
`~/.mine-labs/servers/`; extracted runtimes are shared under `~/.mine-labs/runtimes/`.
`MINE_LABS_RUNTIME_HOME` overrides the extracted-runtime cache location.

Minecraft, RCON, and the dashboard API bind to `127.0.0.1`. Servers run in offline
mode for local testing. Generated evidence stays local: `.mine-labs/` and resolved
`scenario.json` snapshots are ignored by Git. Snapshots can contain environment
values declared in a scenario.

The managed spectator is configured automatically. To give your own local player
operator access, create `$XDG_CONFIG_HOME/minelabs/config.json`, or
`~/.config/minelabs/config.json` when `XDG_CONFIG_HOME` is unset:

```json
{ "schemaVersion": 1, "operators": ["ExamplePlayer"] }
```

`MINE_LABS_CONFIG` overrides the file location. No config file is required.
Configured operators join as spectators with night vision.

## Going further

- [Scenario format, goals, templates, and client protocol](docs/reference.md)
- [Natural-world verification](docs/reference.md#natural-world-verification): test goals at separated locations on a seed with `verify`.
- [Minecraft dashboard and client mod](client-mod/README.md)
- [Architecture and source reading guide](docs/architecture.md)
- Measurements: [verification timing](docs/verification-benchmark.md) and [memory use](docs/verification-memory-profile.md)

Run `bun run dev --help` or `bun run dev run --help` for command options.

## Development

```bash
bun run typecheck
bun test
bun run test:integration
```

`bun test` runs the fast harness checks without starting Minecraft. The separate
integration command starts a real server, interrupts it, and
checks that another run can reuse its ports. It needs Java 21, a server download
or cache, and writable temporary storage. On restricted hosts, set `TEMP` and
`TMP` to a writable directory inside the workspace.

## License

[MIT](LICENSE). Minecraft and third-party dependencies retain their own licenses.
