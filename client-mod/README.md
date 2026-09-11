# Mine Labs UI client mod

Client-only NeoForge 1.21.4 UI for Mine Labs. It polls the session's loopback-only
control API, renders a compact test HUD, and opens
the control dashboard with F10. The HUD and dashboard show the active scenario's
success condition. Its Overview tab summarizes rolling pass rates,
records, and average durations over the latest 15 results per scenario, with the
latest five outcomes shown separately. The dashboard can toggle
Keep running without ending the command; Recent runs keeps the individual
result details. Scenario folders become catalogue categories automatically: use
the folder row to browse one category or make that folder the active suite. The
Minecraft server does not load this mod.

Use **Repeat: FOLDER** to advance through the active suite scope or switch it to
**Repeat: ONE** to repeat the active scenario. Clicking a scenario while Repeat:
ONE is active changes the repeated target. **Run folder** limits the suite scope
to the displayed folder; return to **Folder: ALL** and choose **Run all** to
restore the full catalogue.

## Development build and manual installation

The managed client is the supported experience. To build the mod from a source
checkout for development:

```bash
bun run dev ui build
```

The command prints the JAR path under `client-mod/build/libs/`. If you maintain
your own Minecraft Java 1.21.4 / NeoForge 21.4 instance, close it, remove any older
Mine Labs UI JAR from its `mods/` directory, and copy the built JAR there. Use the
regular JAR, not the sources JAR. Restart that instance to load the mod.

Manual copying only installs the mod; it does not start a Mine Labs session.
To connect it to a running local session, set the client JVM property
`-Dminelabs.uiUrl=http://127.0.0.1:PORT` to that session's control API port. You can
choose a fixed port with `run --client --ui-port PORT`.

## Managed client

This is an unofficial Minecraft mod, not affiliated with or approved by Mojang or
Microsoft. You must own Minecraft: Java Edition and agree to the
[Minecraft EULA](https://www.minecraft.net/en-us/eula). The local offline
development launch does not replace game ownership.

Run `bunx --bun mine-labs run --client ./scenarios` to launch the bundled NeoForge
development client and open its scenario dashboard. No separate instance install
is required. The dashboard is also available from the title screen and F10.
The session passes its local API URL to the client and publishes a new connection
target after each selected world is prepared. First-run client/build files live
under `.mine-labs/open/client/`, outside the installed package.

Search matches words anywhere in a scenario's folder-relative name. The folder
dropdown supports the mouse wheel and arrow keys; Enter selects a folder. Hover
a scenario to read its full name. Search and folder filters also apply to recent
runs.

**Refresh** reloads the YAML catalog, including additions, removals, and changed
setup or goals. The active trial keeps its original configuration; the next
selection uses the refreshed version. Invalid YAML reports an error and leaves
the previous catalog available.

Selecting a scenario immediately opens a preparation screen until its world is
ready. **Return to Labs**, available in the dashboard and Minecraft pause menu,
cancels the active trial, closes its world, and returns to the selector while
keeping the client open. F10 opens the dashboard in-world, from the title screen,
or from the pause menu, and closes it when already open.

Immediately before execution, spectators arrive four blocks above and six behind
the first declared bot, in its prepared dimension, looking down about 34 degrees.
Late arrivals receive the same view once; you can fly freely afterward.
**Teleport to bot** in the dashboard or pause menu restores that camera offset
relative to the bot's current position and heading. It is available while you are connected as a spectator and
the bot is online; it does not require Mine AI's separate observer mod.

**Info** beside a scenario previews its complete conditions without starting it.
**Scenario details** opens the current or most recent run's original conditions,
including after a catalog refresh. Its **Goals** tab preserves nested AND/OR
requirements and shows the latest observed status and detail for every condition,
plus the overall time limit. **Starting setup** lists world rules, players,
inventory, entities and arrangement. **Driver parameters** shows the values
handed to the bot driver; driver-defined completion checks are labeled explicitly.
All text wraps and scrolls with the mouse wheel, arrows, Page Up/Down, Home/End.

**Parallel** selects the worker count while idle. A scenario selection runs one copy per worker; a folder selection visits each entry once. Worker 1 owns the spectator connection; other workers run independently and contribute to the same results. **Keep running** repeats the selected scenario or folder. Worker 1 prepares one fresh server ahead and holds its world frozen until selected and the observer has connected. Schedule changes discard stale preparation. Other workers can reuse compatible declared resets.
