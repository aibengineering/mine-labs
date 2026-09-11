# Mine Labs architecture and reading guide

Mine Labs is a language-neutral experiment harness. It prepares a Minecraft server and scenario, hands connection details to an external client process, observes the declared goal, and records the result. The client owns the bot, its behaviour, and client-specific diagnostics.

## Mental model

There are two execution classes. `session/run.ts` owns isolated fixtures and
observed scenario execution. `session/verification.ts` owns natural-world goal
verification: expand a manifest's seed/location list, group compatible separated
attempts, start a fresh shared server, run clients independently, then dispose of
the batch world. `verify --isolated` replays those same inputs on individual servers.

Shared attempts use `runVerificationTrial` in `trial/run.ts`, which owns client
preparation, measurement and cleanup but performs no world arrangement, datapack
reload, entity clearing or terrain restoration. Both trial paths use the same
client handshake and goal settlement. RCON serializes whole observations with
asynchronous caller ownership so concurrent clients cannot corrupt shared scores.

```text
public API or CLI
└── session: schedule one or more trials
    └── trial: execute one scenario once
        ├── scenario: parse and arrange the requested world
        ├── server: own Minecraft and RCON lifecycle
        ├── client: launch and coordinate external client processes
        ├── player: prepare declared players
        └── goals: independently determine the outcome

report and UI observe completed or active work
```

The three central concepts are:

- **Scenario**: the validated description of the world, players, client command, and goal.
- **Trial**: one execution of one scenario against a server.
- **Session**: scheduling, repetition, parallelism, and operator control around trials.

## Source layers

| Path | Owns | Deliberately does not own |
| --- | --- | --- |
| [`src/scenario`](../src/scenario) | Scenario schema, YAML loading, world-command compilation, categories | Running clients or deciding their behaviour |
| [`src/trial`](../src/trial) | One trial's arrange, handoff, observation, settlement, and cleanup sequence | Cross-trial scheduling |
| [`src/session`](../src/session) | Repetition, isolated parallel workers, automatic server reuse, cancellation, selection | Minecraft protocol details or client behaviour |
| [`src/client`](../src/client) | JSON-lines protocol, subprocess lifecycle, Node client convenience API | Bot choice, AI logic, pathfinding, memory, or telemetry |
| [`src/server`](../src/server) | Server download/runtime, ports, Java process, RCON, world lifetime | Scenario success policy |
| [`src/player`](../src/player) | Resetting and preparing declared players | Creating the external client process |
| [`src/report`](../src/report) | Durable JSON run evidence and retention | Establishing whether a goal passed |
| [`src/ui`](../src/ui) | Optional local observer and control surface | Core orchestration authority |
| [`src/process`](../src/process) | Shared child-process cleanup mechanics | Server- or client-specific policy |
| [`src/cli.ts`](../src/cli.ts) | Command-line composition and presentation | Core trial or scheduling behaviour |
| [`src/index.ts`](../src/index.ts) | Stable public package exports | Implementation details |

## Runtime journey: one scenario

1. `loadScenario` in [`src/scenario/loader.ts`](../src/scenario/loader.ts) resolves an optional scenario template, then parses the merged fields through `scenarioSchema`. It produces a validated `Scenario` whose client and player references are internally consistent.
2. `runScenario` in [`src/trial/run.ts`](../src/trial/run.ts) prepares a world directory and starts `MinecraftServer`.
3. `runScenarioTrial` arranges the scenario using `compileScenario`, then launches the declared client command through `launchScenarioClient`.
4. Mine Labs waits for the client to report ready and for the declared player to join. `preparePlayerForTrial` then resets and equips that player.
5. Mine Labs sends the client a start message. The client performs whatever test behaviour it owns.
6. `awaitScenarioGoal` repeatedly calls the goal evaluator. Server-observable goals use RCON; a `completion` goal uses the client's explicit completion event.
7. The trial stops its clients and either resets the reused server or lets `runScenario` stop the fresh server.
8. The CLI or session layer sends the resulting `RunResult` to [`src/report/artifacts.ts`](../src/report/artifacts.ts).

The important invariant is that client completion and server-observed facts are distinct sources of evidence. A client cannot declare a reach, kill, inventory, block, or health goal successful merely by saying it completed.

## Session execution and the client

The CLI run command and the NeoForge dashboard share runSession in src/session/run.ts.
The scheduler assigns one trial at a time to each worker. src/session/worker.ts owns
that worker's server, deferred arena restore, and replacement on incompatibility or
reset failure. src/session/reuse.ts owns reset eligibility and world compatibility.
Worlds live outside trial result directories so evidence retention cannot remove a
live world. Cancellation reaches every worker, and shutdown awaits their cleanup.

src/ui/open.ts composes the catalog, control API and bundled NeoForge client.
The client follows worker 1; other workers execute without a spectator gate.
`session/client-worker.ts` owns the observed server and one speculative successor.
It asks the scheduler for a non-consuming prediction, prepares a fresh world
behind an asynchronous selection gate, and exposes only the selected
connection. World ticking is frozen before setup until the observer is placed
and the bots are about to start. Because vanilla freeze excludes players, bots
join only after selection. Stale preparations are cancelled and disposed;
only selected trials publish evidence. Retirement completes before another
standby boots, bounding the extra server count to one. Connection IDs identify
server lifetimes. The completed world is retained until selection or shutdown.
The same controller owns selection, repetition, folder batches and concurrency.
Both headless and dashboard runs use this session lifecycle.

## Reading order

Read production code first and open the colocated test whenever you want executable examples of the contract.

1. [`README.md`](../README.md) — product intent and first run; [`reference.md`](reference.md) — scenario format, client protocol, and CLI details.
2. [`src/index.ts`](../src/index.ts) — the supported public API.
3. [`src/scenario/schema.ts`](../src/scenario/schema.ts), then [`src/scenario/goal-schema.ts`](../src/scenario/goal-schema.ts) — scenario assembly first, followed by the recursive goal vocabulary.
4. [`src/trial/run.ts`](../src/trial/run.ts) — the main single-trial story. Read `runScenario`, then `runScenarioTrial`, `connectScenarioClients`, `awaitScenarioGoal`, and `arrangeScenario`.
5. [`src/trial/goals.ts`](../src/trial/goals.ts) — goal authority, initial observations, and pass/fail evidence.
6. [`src/client/protocol.ts`](../src/client/protocol.ts), [`src/client/process.ts`](../src/client/process.ts), and [`src/client/node.ts`](../src/client/node.ts) — the language-neutral boundary and the optional Node helper.
7. [`src/server/server.ts`](../src/server/server.ts), [`src/scenario/compile.ts`](../src/scenario/compile.ts), and [`src/player/prepare.ts`](../src/player/prepare.ts) — the effects that support one trial.
8. [`src/session/run.ts`](../src/session/run.ts), then [`src/session/controller.ts`](../src/session/controller.ts) — repetition, parallel scheduling, world reuse, and control.
9. [`src/report/artifacts.ts`](../src/report/artifacts.ts) — evidence persistence and retention.
10. [`src/ui/server.ts`](../src/ui/server.ts) and [`client-mod`](../client-mod) — optional observation surfaces.
11. [`src/cli.ts`](../src/cli.ts) — command composition, best read after the capabilities it wires together.

## Where to make common changes

- Change the scenario file format in `src/scenario/schema.ts`, then update loading/compilation tests and the README.
- Change setup commands or datapack generation in `src/scenario/compile.ts`.
- Change when one trial starts, settles, or cleans up in `src/trial/run.ts`.
- Add or change an independently observed goal in `src/trial/goals.ts` and `src/scenario/schema.ts`.
- Change external-client messages in `src/client/protocol.ts`; update both runner and Node-client sides together.
- Change repetition or worker allocation in `src/session/run.ts` without moving client behaviour into the harness.
- Change operator controls in `src/session/controller.ts`; the UI should remain an adapter to this authority.
- Change server startup, shutdown, ports, or RCON in `src/server`.

When changing lifecycle code, preserve cleanup for the Java server and every external client on success, failure, timeout, and cancellation.
