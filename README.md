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
bun run mine-labs run --spectator scenarios
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
bun run dev run --spectator examples/scenarios
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

With `--spectator`, `run` opens the dashboard. A folder lets you choose a scenario;
a single file starts that scenario. F10 opens the dashboard in-game. Inspect the
result, run it again, or select another scenario. **Return to Labs** closes the
active world and keeps the dashboard open; closing Minecraft or pressing Ctrl+C
stops the session.

Without `--spectator`, the same scenarios run from the terminal:

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

In spectator mode, the observed worker prepares one fresh server ahead while the
current scenario runs. It freezes world ticking before setup and holds the
prepared world until that scenario is selected. Bots then join and prepare;
the observer connects once they are ready. Then
world ticking and bot execution start together. Changing the schedule discards
stale preparation; stopping closes both servers. This uses up to one extra server.

Headless workers and the other parallel workers reuse compatible, resettable
worlds. Add `--isolated` when every attempt must start in a fresh world.

Keep running is a repeat preference: toggling it while idle stays in the menu.
Choose Repeat: ONE to loop a single scenario, turn Keep running on, then click that
scenario to start. Run folder / Run all explicitly starts the selected scope.
While a trial is running, turning Keep running off lets active trials finish;
turning it on before they finish enables continuation. Once paused, select a
scenario or folder to start again. Explicit CLI runs (including `--repeat forever`)
still start immediately.

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
bun run dev run --spectator scenarios
```

### Watch from another device: Tailscale remote mode

To drive and watch the lab from your own Minecraft install, such as a phone
launcher, run it in Tailscale remote mode instead of `--spectator`:

```bash
bun run dev run --tailscale examples/scenarios
```

Remote mode needs [Tailscale](https://tailscale.com) running on this machine and
on the device. It opens no client here. It serves the dashboard and every scenario
world on this machine's tailnet address only, and has no login of its own, so
anyone who can reach that address on your tailnet can run and stop scenarios.

Mine Labs prints the lab address, such as `http://100.101.102.103:25578`. On the
device:

1. Open that address in a browser and download the mods it lists.
2. Add them to a NeoForge 1.21.4 instance in your launcher.
3. Start Minecraft, choose **Mine Labs** on the title screen, and enter the address.

The address is saved, so later launches open the dashboard directly. Use your
normal account: the lab watches for whichever player the mod reports. Re-download
the mods when the scenarios' spectator mods change.


### Inspect before starting

**Auto-start: ON** is the default in the managed client. Turn it **OFF** to load
and inspect the watched scenario before running it. Once ready, the world stays
frozen, the bot drivers wait for their start signal, and the trial timer has not
started. Players still tick while frozen, so air, fire, and effects keep changing
until the scenario starts. Fly around or press **F9** for scenario details, then press **F8** or
click **Start scenario** in the F10 dashboard. F8 can be rebound in Minecraft's
Controls settings.

This preference lasts for the session and applies to each watched scenario,
including repeats. Turning Auto-start back on releases a scenario already waiting.
Changing it during a run affects the next scenario. **Keep running** separately
controls whether another trial loads after completion. Background parallel workers
continue automatically. Return to Labs, selecting another scenario, and stopping
all cancel the pending start; an old start click cannot release a newer trial.

The loopback API exposes `autoStartEnabled`, `awaitingStartTrialId`, and phase
`ready`. Use `{"action":"auto-start","enabled":false}` to change the preference
and `{"action":"start","trialId":"<awaitingStartTrialId>"}` to start that trial
via `POST /api/control`. A stale or premature start returns HTTP 409.

### Block groups

Use `blocksAt` to require the same block at several explicit world coordinates:

```yaml
goal:
  kind: blocksAt
  block: stone
  positions: [[0, 64, 0], [1, 64, 0], [2, 64, 0]]
```

Every position must match. Mine Labs checks the server's world in the scenario's
dimension and reports how many positions match and the coordinates that do not.
The list must contain at least one coordinate triple. `blockAt` remains available
for a single position. Both block goals require integer cell coordinates;
player positions and `reach` goals may use fractional coordinates.

Combine several `blocksAt` goals under `kind: all` for different block types,
including `air` where space must be clear. The scenario owns the coordinates and
what they represent; Mine Labs has no built-in structure shapes. Add a `completion`
goal when client action calls must also report success.

### Starting equipment

Declare worn or held items under a player's `equipment`, separately from carried
`inventory`. Mine Labs equips them during player preparation, before activating
scenario entities or sending the client its start signal:

```yaml
players:
  - name: Barterer
    inventory:
      - { item: gold_ingot, count: 3 }
    equipment:
      head: golden_helmet
```

Supported slots are `head`, `chest`, `legs`, `feet`, `mainhand`, and `offhand`.
Each entry grants one item directly into that slot; do not also list it in
inventory unless a spare is intended. Equipment is applied after reusable-player
cleanup and before inventory grants, so a held item cannot overwrite a grant.
The scenario details screen includes this starting equipment.

Additional viewer mods are declared with `spectator.mods` in a scenario or template; see [Spectator mods](docs/reference.md#spectator-mods). The YAML `client` remains the external scenario participant.

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


## Scenario purpose and labels

Press **F9** to open the current (or most recently run) scenario's details directly.
Press F9 again or Escape to return to the previous screen or world. The shortcut
is remappable under Minecraft Controls → Mine Labs; F10 still opens the dashboard.
Details show the scenario's purpose, labels, declared setup, parameters and live
goal observations. Viewing details does not pause a running trial.

Scenarios may declare `tags: [navigation, smoke]`. Mine Labs has no built-in test
types: your suite owns the vocabulary and should document each label's meaning.
Tags are nonempty strings with surrounding whitespace trimmed, default to an empty
list, and can be inherited from templates. A fixture's `tags` replaces the whole
inherited list. Labels are case-sensitive; lowercase names are a useful convention.
Use `description` for the reason a fixture exists. Folders and tags are independent.

Every tag appears as a text badge. Its exact label deterministically selects a
color from a fixed palette, shared by the scenario list, tag filter and details
screen. Catalog order, filtering and newly added tags do not change existing
colors. Colors carry no test-type meaning and may repeat; the text identifies the
tag. Green and red remain reserved for result states. There is no color configuration
or special styling for particular tag names.

The dashboard searches tags alongside names and cycles available labels with the
All tags button. These filters affect the displayed list; Run folder and Run all
continue to run their entire folder scope, as with text search.

```yaml
name: lava-approach
tags: [navigation, smoke]
description: >-
  Guard against the observed overshoot into lava after a downhill approach.
  The bot must finish the approach with full health and successful completion.
```

Refreshing the catalog updates labels for future runs. Current-run details retain
the original description, tags and goals alongside that run's observations.

## License

[MIT](LICENSE). Minecraft and third-party dependencies retain their own licenses.
