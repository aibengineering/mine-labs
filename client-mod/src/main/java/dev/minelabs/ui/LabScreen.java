package dev.minelabs.ui;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import net.minecraft.ChatFormatting;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.network.chat.Component;
import org.lwjgl.glfw.GLFW;

/**
 * The dashboard, in two columns: controls stacked in a narrow sidebar on the
 * left, and the scenario list using the full height on the right. On a phone,
 * where the scaled screen is short, a single centred column left room for only
 * a few scenarios below its rows of controls.
 */
final class LabScreen extends Screen {
    private static final int TITLE = 0xFFF4F8FF;
    private static final int TEXT = 0xFFDDE8FA;
    private static final int MUTED = 0xFF91A0B8;
    private static final int GOOD = 0xFF79D99A;
    private static final int BAD = 0xFFFF7070;
    private static final int BAR_BACKGROUND = 0xFF273143;
    private static final int DIVIDER = 0x40FFFFFF;
    private static final int MARGIN = 8;
    private static final int GAP = 4;
    /** Between the sidebar and the panel; the divider line sits in its middle. */
    private static final int COLUMN_GAP = 10;
    private static final int HEADER_HEIGHT = 22;
    /** Sidebar rows: a 20px button and a 2px gap. */
    private static final int CONTROL_PITCH = 22;
    private static final int ROW_HEIGHT = 20;
    private static final int INFO_WIDTH = 40;
    private static final int PAGE_BUTTON_WIDTH = 20;
    private static final int PAGE_LABEL_WIDTH = 44;
    private static final int FOLDER_ROW_HEIGHT = 20;

    private final LabApiClient api;
    private View view = View.OVERVIEW;
    private String category;
    private String tag;
    private int page;
    private String query = "";
    private List<String> displayedScenarios = List.of();
    private Map<String, List<String>> displayedTags = Map.of();
    private boolean displayedConnection;
    private boolean filtersDirty;
    private boolean folderOpen;
    private int folderOffset;
    private int folderCursor;
    /** Where the sidebar's controls end; the run totals go below. */
    private int sidebarBottom;
    private Button startButton;
    private Button detailsButton;
    private Button refreshButton;
    private Button autoStartButton;
    private Button continuousButton;
    private Button singleScenarioButton;
    private Button jobsButton;
    private Button runCategoryButton;
    private Button teleportButton;
    private EditBox search;
    private Button categoryButton;
    private Button previousPage;
    private Button nextPage;

    LabScreen(LabApiClient api) {
        super(Component.literal("Mine Labs test dashboard"));
        this.api = api;
    }

    @Override
    protected void init() {
        folderOpen = false;
        LabApiClient.Snapshot snapshot = api.snapshot();
        displayedScenarios = snapshot.scenarios();
        displayedTags = snapshot.scenarioTags();
        if (tag != null && !availableTags(snapshot).contains(tag)) tag = null;
        displayedConnection = snapshot.connection() != null;
        normalizeCategory(snapshot);

        sidebarBottom = addSidebar(snapshot);
        addFilters(snapshot);
        page = Math.min(page, pageCount(snapshot) - 1);
        if (view == View.OVERVIEW) addScenarioButtons(snapshot);
        int pageLeft = pagerLeft();
        previousPage = addRenderableWidget(Button.builder(Component.literal("<"), button -> changePage(-1))
                .bounds(pageLeft, footerY(), PAGE_BUTTON_WIDTH, 20).build());
        nextPage = addRenderableWidget(Button.builder(Component.literal(">"), button -> changePage(1))
                .bounds(pageLeft + PAGE_BUTTON_WIDTH + PAGE_LABEL_WIDTH, footerY(), PAGE_BUTTON_WIDTH, 20).build());
    }

    /**
     * Full-width buttons for the main actions, pairs for the rest.
     * Returns the bottom edge of the last row.
     */
    private int addSidebar(LabApiClient.Snapshot snapshot) {
        int x = MARGIN;
        int full = sidebarWidth();
        int half = (full - GAP) / 2;
        int right = x + half + GAP;
        int y = HEADER_HEIGHT + GAP;
        startButton = addRenderableWidget(Button.builder(Component.literal("Start scenario (" + ClientEvents.startKeyLabel() + ")"), button -> ClientEvents.startScenario())
                .bounds(x, y, full, 20).build());
        y += CONTROL_PITCH;
        detailsButton = addRenderableWidget(Button.builder(Component.literal("Details"), button ->
                minecraft.setScreen(new LabDetailsScreen(api, api.snapshot().currentScenario(), true)))
                .bounds(x, y, half, 20).build());
        detailsButton.setTooltip(Tooltip.create(Component.literal("Full goals and live checks for the current scenario (" + ClientEvents.detailsKeyLabel() + ").")));
        refreshButton = addRenderableWidget(Button.builder(Component.literal("Refresh"), button -> api.control("refresh", null))
                .bounds(right, y, half, 20).build());
        refreshButton.setTooltip(Tooltip.create(Component.literal("Reload scenario YAMLs from disk. The active run keeps its original setup.")));
        y += CONTROL_PITCH;
        addRenderableWidget(Button.builder(tabLabel("Scenarios", View.OVERVIEW), button -> switchView(View.OVERVIEW))
                .bounds(x, y, half, 20).build());
        addRenderableWidget(Button.builder(tabLabel("Recent", View.RECENT), button -> switchView(View.RECENT))
                .bounds(right, y, half, 20).build());
        y += CONTROL_PITCH;
        autoStartButton = addRenderableWidget(Button.builder(Component.literal("Auto-start: ON"), button ->
                api.setAutoStart(!api.snapshot().autoStartEnabled()))
                .bounds(x, y, half, 20).build());
        autoStartButton.setTooltip(Tooltip.create(Component.literal("ON starts when the world is ready. OFF lets you inspect the frozen world first. Applies to the watched worker; background workers continue automatically.")));
        continuousButton = addRenderableWidget(Button.builder(continuousLabel(snapshot), button ->
                        api.setContinuous(!api.snapshot().continuousEnabled()))
                .bounds(right, y, half, 20).build());
        continuousButton.setTooltip(Tooltip.create(Component.literal("Keep running: start the next scenario when one finishes.")));
        y += CONTROL_PITCH;
        singleScenarioButton = addRenderableWidget(Button.builder(singleScenarioLabel(snapshot), button ->
                        api.setSingleScenario(!api.snapshot().singleScenarioEnabled()))
                .bounds(x, y, half, 20).build());
        singleScenarioButton.setTooltip(Tooltip.create(Component.literal("ONE loops the selected scenario. FOLDER cycles through the folder.")));
        jobsButton = addRenderableWidget(Button.builder(Component.literal("Parallel: " + snapshot.jobs()), button -> {
                    LabApiClient.Snapshot current = api.snapshot();
                    api.setJobs(current.jobs() >= current.maxJobs() ? 1 : current.jobs() + 1);
                })
                .bounds(right, y, half, 20).build());
        jobsButton.setTooltip(Tooltip.create(Component.literal("Selecting a scenario runs one copy per worker. A folder runs each scenario once. The camera follows worker 1. Change while idle.")));
        y += CONTROL_PITCH;
        runCategoryButton = addRenderableWidget(Button.builder(Component.literal(runCategoryLabel()), button ->
                        { api.selectCategory(category); minecraft.setScreen(new LabLoadingScreen(api, category == null ? "All scenarios" : category)); })
                .bounds(x, y, full, 20).build());
        y += CONTROL_PITCH;
        // A connected managed client can reach the bot's world; any other client
        // not launched with an address can be pointed at a lab instead.
        teleportButton = null;
        if (ClientEvents.managed() && snapshot.connection() != null) {
            teleportButton = addRenderableWidget(Button.builder(Component.literal("Teleport to bot"), button -> ClientEvents.teleportToBot())
                    .bounds(x, y, half, 20).build());
            teleportButton.setTooltip(Tooltip.create(Component.literal("Jump to the first scenario bot's current position and dimension.")));
            addRenderableWidget(Button.builder(Component.literal("Join world"), button -> ClientEvents.reconnect())
                    .bounds(right, y, half, 20).build());
            y += CONTROL_PITCH;
        } else if (!LabConfig.launchedWithUrl()) {
            addRenderableWidget(Button.builder(Component.literal("Lab address"), button ->
                    minecraft.setScreen(new LabAddressScreen(api, this)))
                    .bounds(x, y, full, 20).build())
                    .setTooltip(Tooltip.create(Component.literal("Connect to another lab, such as one in Tailscale remote mode.")));
            y += CONTROL_PITCH;
        }
        addRenderableWidget(Button.builder(Component.literal(ClientEvents.managed() ? "Return to Labs" : "Skip active"), button -> {
                    if (ClientEvents.managed()) ClientEvents.returnToLabs();
                    else api.control("skip", null);
                })
                .bounds(x, y, half, 20).build());
        addRenderableWidget(Button.builder(Component.literal(ClientEvents.managed() ? "Exit Labs" : "Stop run"), button -> api.control("stop", null))
                .bounds(right, y, half, 20).build());
        return y + 20;
    }

    /** One row above the list: search on the left, then the folder and tag pickers. */
    private void addFilters(LabApiClient.Snapshot snapshot) {
        int left = panelLeft();
        int tagWidth = Math.min(90, panelWidth() / 4);
        int folderButtonWidth = Math.min(130, panelWidth() / 3);
        int searchWidth = panelWidth() - folderButtonWidth - tagWidth - GAP * 2;
        int cursor = search == null ? query.length() : search.getCursorPosition();
        search = addRenderableWidget(new EditBox(font, left, filterY(), searchWidth, 20, Component.literal("Search scenarios")));
        search.setMaxLength(200);
        search.setHint(Component.literal("Search names or tags..."));
        search.setValue(query);
        search.setCursorPosition(cursor);
        search.setResponder(value -> { query = value; page = 0; filtersDirty = true; });
        categoryButton = addRenderableWidget(Button.builder(Component.literal(categoryLabel(snapshot)), button -> {
                    folderOpen = !folderOpen;
                    folderCursor = category == null ? 0 : snapshot.categories().stream().map(LabApiClient.Category::name).toList().indexOf(category) + 1;
                    folderOffset = Math.max(0, Math.min(folderCursor, folderCount() - folderCapacity()));
                })
                .bounds(left + searchWidth + GAP, filterY(), folderButtonWidth, 20).build());
        categoryButton.setTooltip(Tooltip.create(Component.literal("Choose a folder. Scroll or use arrow keys in the list.")));
        Button tagButton = addRenderableWidget(Button.builder(tag == null ? Component.literal("All tags") : TagStyle.badge(tag), button -> {
            List<String> tags = availableTags(api.snapshot());
            int next = tag == null ? 0 : tags.indexOf(tag) + 1;
            tag = next < tags.size() ? tags.get(next) : null;
            page = 0;
            rebuildWidgets();
        }).bounds(panelRight() - tagWidth, filterY(), tagWidth, 20).build());
        tagButton.setTooltip(Tooltip.create(Component.literal("Cycle labels to filter the list across folders. Run folder / Run all still runs the entire folder.")));
    }

    @Override
    protected void rebuildWidgets() {
        // Screen.rebuildWidgets clears focus before init. Preserve it explicitly
        // so filtering does not interrupt typing after the first character.
        boolean typing = search != null && search.isFocused();
        int cursor = search == null ? 0 : search.getCursorPosition();
        super.rebuildWidgets();
        if (typing) {
            setFocused(search);
            search.setCursorPosition(cursor);
        }
    }

    @Override
    public void tick() {
        LabApiClient.Snapshot snapshot = api.snapshot();
        // The title screen can open before the first HTTP response arrives.
        if (filtersDirty || !displayedTags.equals(snapshot.scenarioTags()) || !displayedScenarios.equals(snapshot.scenarios())
                || displayedConnection != (snapshot.connection() != null)) {
            filtersDirty = false;
            normalizeCategory(snapshot);
            folderOpen = false;
            rebuildWidgets();
        }
        if (snapshot.phase().equals("preparing") || snapshot.phase().equals("returning")) {
            minecraft.setScreen(new LabLoadingScreen(api, snapshot.active() == null ? snapshot.message() : snapshot.active().scenario()));
        }
    }

    @Override
    public void onClose() {
        if (minecraft != null) minecraft.setScreen(minecraft.level == null ? new TitleScreen() : null);
    }

    private void addScenarioButtons(LabApiClient.Snapshot snapshot) {
        List<LabApiClient.ScenarioStats> statistics = visibleStatistics(snapshot);
        int start = page * rowCapacity();
        int end = Math.min(statistics.size(), start + rowCapacity());
        int x = panelLeft();
        // The name button and its Info button fill the name column, less a gap before the stats.
        int buttonWidth = scenarioColumnWidth() - INFO_WIDTH - 2 * GAP;
        for (int index = start; index < end; index++) {
            LabApiClient.ScenarioStats stats = statistics.get(index);
            int y = rowsY() + (index - start) * ROW_HEIGHT;
            var label = Component.empty();
            for (String tag : snapshot.tagsFor(stats.scenario()))
                label.append(TagStyle.badge(tag)).append(" ");
            label.append(Component.literal(stats.scenario()).withStyle(ChatFormatting.WHITE));
            Button button = Button.builder(label, ignored -> ClientEvents.selectScenario(stats.scenario()))
                    .bounds(x, y, buttonWidth, 18)
                    .build();
            button.active = snapshot.scenarios().contains(stats.scenario());
            button.setTooltip(Tooltip.create(Component.literal(stats.scenario() + "\nTags: " + String.join(", ", snapshot.tagsFor(stats.scenario())))));
            addRenderableWidget(button);
            addRenderableWidget(Button.builder(Component.literal("Info"), ignored ->
                    minecraft.setScreen(new LabDetailsScreen(api, stats.scenario(), false)))
                    .bounds(x + buttonWidth + GAP, y, INFO_WIDTH, 18).build());
        }
    }

    @Override
    public void render(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
        LabApiClient.Snapshot snapshot = api.snapshot();
        updateControls(snapshot);
        updatePagination(snapshot);
        super.render(graphics, mouseX, mouseY, partialTick);
        String heading = "Mine Labs";
        graphics.drawString(font, heading, MARGIN, 8, TITLE, false);
        String message = !api.notice().isBlank() ? api.notice() : snapshot.supported() ? snapshot.message() : snapshot.versionNotice();
        int messageLeft = MARGIN + font.width(heading) + 12;
        boolean healthy = snapshot.available() && snapshot.supported() && !api.controlFailed();
        graphics.drawString(font, fitWidth(message, width - messageLeft - MARGIN), messageLeft, 8, healthy ? TEXT : BAD, false);
        renderSummary(graphics, snapshot.totals());
        if (view == View.OVERVIEW) renderOverview(graphics, snapshot);
        else renderRecent(graphics, snapshot);
        renderFooter(graphics, snapshot);
        if (folderOpen) renderFolders(graphics, mouseX, mouseY);
    }

    @Override
    public void renderBackground(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
        graphics.fill(0, 0, width, height, 0xF5101726);
        int dividerX = sidebarRight() + COLUMN_GAP / 2 - 1;
        graphics.fill(dividerX, HEADER_HEIGHT, dividerX + 1, height - MARGIN, DIVIDER);
    }

    /** Totals go under the sidebar's controls, when the screen is tall enough for them. */
    private void renderSummary(GuiGraphics graphics, LabApiClient.Totals totals) {
        int y = sidebarBottom + 8;
        if (y + 30 > height - MARGIN) return;
        int completed = totals.passed() + totals.failed();
        String rate = completed == 0 ? "—" : Math.round(100.0f * totals.passed() / completed) + "%";
        graphics.drawString(font, fitWidth("Last " + totals.runs() + " runs  •  " + rate + " pass", sidebarWidth()), MARGIN, y, TEXT, false);
        graphics.drawString(font, fitWidth(totals.passed() + " pass  •  " + totals.failed() + " fail  •  " + totals.cancelled() + " cancelled", sidebarWidth()), MARGIN, y + 11, MUTED, false);
        drawResultBar(graphics, MARGIN, y + 23, sidebarWidth(), 5, totals.passed(), totals.failed(), totals.cancelled());
        String hint = "Esc or " + ClientEvents.dashboardKeyLabel() + " closes";
        if (y + 44 <= height - MARGIN) graphics.drawString(font, hint, MARGIN, y + 36, MUTED, false);
    }

    private void renderOverview(GuiGraphics graphics, LabApiClient.Snapshot snapshot) {
        int left = panelLeft();
        int nameWidth = scenarioColumnWidth();
        int rateX = left + nameWidth;
        int recordX = rateX + 105;
        int averageX = recordX + 92;
        int recentX = averageX + 74;
        String testHeader = snapshot.singleScenarioEnabled() ? "TEST  /  TAP TO LOOP" : "TEST  /  TAP TO RUN NEXT";
        graphics.drawString(font, fitWidth(testHeader, nameWidth - 8), left, tableHeaderY(), MUTED, false);
        graphics.drawString(font, "PASS / 15", rateX, tableHeaderY(), MUTED, false);
        if (showRecord()) graphics.drawString(font, "RECORD / 15", recordX, tableHeaderY(), MUTED, false);
        if (showAverage()) graphics.drawString(font, "AVG", averageX, tableHeaderY(), MUTED, false);
        if (showRecentForm()) graphics.drawString(font, "RECENT", recentX, tableHeaderY(), MUTED, false);

        List<LabApiClient.ScenarioStats> statistics = visibleStatistics(snapshot);
        int start = page * rowCapacity();
        int end = Math.min(statistics.size(), start + rowCapacity());
        for (int index = start; index < end; index++) {
            LabApiClient.ScenarioStats stats = statistics.get(index);
            // Level with the text on the row's 18px scenario button.
            int y = rowsY() + (index - start) * ROW_HEIGHT + 5;
            String rate = stats.passRate() < 0 ? "—" : stats.passRate() + "%";
            graphics.drawString(font, rate, rateX, y, stats.failed() > 0 ? TEXT : GOOD, false);
            drawResultBar(graphics, rateX + 35, y + 2, 58, 5, stats.passed(), stats.failed(), stats.cancelled());
            if (showRecord()) graphics.drawString(font, stats.passed() + "P  " + stats.failed() + "F  " + stats.cancelled() + "C", recordX, y, TEXT, false);
            if (showAverage()) graphics.drawString(font, duration(stats.averageElapsedMs()), averageX, y, MUTED, false);
            if (showRecentForm()) drawRecentOutcomes(graphics, stats.recentOutcomes(), recentX, y);
        }
        if (statistics.isEmpty()) {
            graphics.drawCenteredString(font, fitWidth("No matching scenarios. Try a different search or folder.", panelWidth()), panelCenter(), rowsY() + 12, MUTED);
        }
    }

    private void renderRecent(GuiGraphics graphics, LabApiClient.Snapshot snapshot) {
        int left = panelLeft();
        int testX = left + 68;
        int durationX = panelRight() - 142;
        int finishedX = panelRight() - 72;
        graphics.drawString(font, "RESULT", left, tableHeaderY(), MUTED, false);
        graphics.drawString(font, "TEST", testX, tableHeaderY(), MUTED, false);
        graphics.drawString(font, "DURATION", durationX, tableHeaderY(), MUTED, false);
        graphics.drawString(font, "FINISHED", finishedX, tableHeaderY(), MUTED, false);
        List<LabApiClient.Result> recent = visibleRecent(snapshot);
        int start = page * rowCapacity();
        int end = Math.min(recent.size(), start + rowCapacity());
        for (int index = start; index < end; index++) {
            LabApiClient.Result result = recent.get(index);
            int y = rowsY() + (index - start) * ROW_HEIGHT;
            graphics.drawString(font, result.outcome().toUpperCase(Locale.ROOT), left, y, outcomeColor(result.outcome()), false);
            graphics.drawString(font, fitWidth(result.scenario(), durationX - 8 - testX), testX, y, TEXT, false);
            graphics.drawString(font, duration(result.elapsedMs()), durationX, y, MUTED, false);
            graphics.drawString(font, age(result.finishedAt()), finishedX, y, MUTED, false);
            // The detail runs under the whole row, indented under the test name.
            graphics.drawString(font, fitWidth(result.detail(), panelRight() - testX - 10), testX + 10, y + 10, MUTED, false);
        }
        if (recent.isEmpty()) {
            graphics.drawCenteredString(font, "No retained test results yet", panelCenter(), rowsY() + 12, MUTED);
        }
    }

    private void renderFooter(GuiGraphics graphics, LabApiClient.Snapshot snapshot) {
        int textY = footerY() + 6;
        String count = visibleStatistics(snapshot).size() + " scenarios  •  stats: latest 15 runs";
        graphics.drawString(font, fitWidth(count, pagerLeft() - GAP * 2 - panelLeft()), panelLeft(), textY, MUTED, false);
        graphics.drawCenteredString(font, (page + 1) + " / " + pageCount(snapshot), pagerLeft() + PAGE_BUTTON_WIDTH + PAGE_LABEL_WIDTH / 2, textY, MUTED);
    }

    private void drawRecentOutcomes(GuiGraphics graphics, List<String> outcomes, int x, int y) {
        int offset = 0;
        for (String outcome : outcomes) {
            String symbol = switch (outcome) {
                case "pass" -> "P";
                case "cancelled" -> "C";
                default -> "F";
            };
            graphics.drawString(font, symbol, x + offset, y, outcomeColor(outcome), false);
            offset += font.width(symbol) + 5;
        }
        if (outcomes.isEmpty()) graphics.drawString(font, "—", x, y, MUTED, false);
    }

    private static void drawResultBar(
            GuiGraphics graphics,
            int x,
            int y,
            int width,
            int height,
            int passed,
            int failed,
            int cancelled) {
        graphics.fill(x, y, x + width, y + height, BAR_BACKGROUND);
        int total = passed + failed + cancelled;
        if (total == 0) return;
        int passWidth = Math.round((float) width * passed / total);
        int failWidth = Math.round((float) width * failed / total);
        if (passWidth > 0) graphics.fill(x, y, x + passWidth, y + height, GOOD);
        if (failWidth > 0) graphics.fill(x + passWidth, y, x + passWidth + failWidth, y + height, BAD);
        int used = passWidth + failWidth;
        if (cancelled > 0 && used < width) graphics.fill(x + used, y, x + width, y + height, MUTED);
    }

    private void switchView(View nextView) {
        if (view == nextView) return;
        view = nextView;
        page = 0;
        rebuildWidgets();
    }

    private void changePage(int direction) {
        int pages = pageCount(api.snapshot());
        page = Math.max(0, Math.min(pages - 1, page + direction));
        rebuildWidgets();
    }

    private void updatePagination(LabApiClient.Snapshot snapshot) {
        int pages = pageCount(snapshot);
        if (previousPage != null) previousPage.active = page > 0;
        if (nextPage != null) nextPage.active = page + 1 < pages;
    }

    private void updateControls(LabApiClient.Snapshot snapshot) {
        if (continuousButton == null) return; // Not initialised yet.
        jobsButton.setMessage(Component.literal("Parallel: " + snapshot.jobs()));
        jobsButton.active = snapshot.available() && snapshot.activeCount() == 0 && api.pendingAction() == null
                && !snapshot.phase().equals("preparing") && !snapshot.phase().equals("returning");
        detailsButton.active = !snapshot.currentScenario().isBlank();
        if (teleportButton != null) teleportButton.active = ClientEvents.canTeleportToBot();
        boolean canControl = snapshot.available()
                && api.pendingAction() == null
                && !snapshot.phase().equals("stopping")
                && !snapshot.phase().equals("stopped");
        continuousButton.setMessage(continuousLabel(snapshot));
        continuousButton.active = canControl;
        autoStartButton.setMessage(Component.literal("Auto-start: " + (snapshot.autoStartEnabled() ? "ON" : "OFF")));
        autoStartButton.active = canControl && ClientEvents.managed();
        startButton.active = canControl && !snapshot.awaitingStartTrialId().isBlank();
        singleScenarioButton.setMessage(singleScenarioLabel(snapshot));
        singleScenarioButton.active = canControl;
        categoryButton.setMessage(Component.literal(categoryLabel(snapshot)));
        refreshButton.active = canControl;
        refreshButton.setMessage(Component.literal("refresh".equals(api.pendingAction()) ? "Refreshing..." : "Refresh"));
        runCategoryButton.setMessage(Component.literal(runCategoryLabel()));
        runCategoryButton.active = canControl;
    }

    private static Component continuousLabel(LabApiClient.Snapshot snapshot) {
        return Component.literal("Keep running: " + (snapshot.continuousEnabled() ? "ON" : "OFF"));
    }

    private static Component singleScenarioLabel(LabApiClient.Snapshot snapshot) {
        return Component.literal("Repeat: " + (snapshot.singleScenarioEnabled() ? "ONE" : "FOLDER"));
    }

    private int pageCount(LabApiClient.Snapshot snapshot) {
        int rows = view == View.OVERVIEW ? visibleStatistics(snapshot).size() : visibleRecent(snapshot).size();
        return Math.max(1, (rows + rowCapacity() - 1) / rowCapacity());
    }

    private List<LabApiClient.ScenarioStats> visibleStatistics(LabApiClient.Snapshot snapshot) {
        return snapshot.scenarioStats().stream()
                .filter(stats -> snapshot.scenarios().contains(stats.scenario()) && matches(stats.scenario(), snapshot)).toList();
    }

    private List<LabApiClient.Result> visibleRecent(LabApiClient.Snapshot snapshot) {
        return snapshot.recent().stream().filter(result -> matches(result.scenario(), snapshot)).toList();
    }

    private List<String> availableTags(LabApiClient.Snapshot snapshot) {
        return snapshot.scenarioTags().values().stream().flatMap(List::stream).distinct().sorted().toList();
    }

    private boolean matches(String scenario, LabApiClient.Snapshot snapshot) {
        if (tag != null && !snapshot.tagsFor(scenario).contains(tag)) return false;
        String name = (scenario + " " + String.join(" ", snapshot.tagsFor(scenario))).toLowerCase(Locale.ROOT);
        for (String term : query.toLowerCase(Locale.ROOT).trim().split("\\s+")) if (!name.contains(term)) return false;
        return category == null || snapshot.categories().stream()
                .anyMatch(folder -> folder.name().equals(category) && folder.scenarios().contains(scenario));
    }

    private void normalizeCategory(LabApiClient.Snapshot snapshot) {
        if (category != null && !hasCategory(snapshot)) category = null;
    }

    private boolean hasCategory(LabApiClient.Snapshot snapshot) {
        return snapshot.categories().stream().anyMatch(candidate -> candidate.name().equals(category));
    }

    /** "Folder: ALL" covers the moment between a folder vanishing and the next tick dropping it. */
    private String categoryLabel(LabApiClient.Snapshot snapshot) {
        if (category == null) return "All folders  v";
        return hasCategory(snapshot) ? category + "  v" : "Folder: ALL";
    }

    private String runCategoryLabel() {
        return category == null ? "Run all" : "Run folder";
    }

    // Geometry. Columns run left to right: MARGIN, sidebar, COLUMN_GAP, panel,
    // MARGIN. Rows in the panel run: header, filter row, table header, list
    // rows, then the footer's count and pager along the bottom margin.
    private int sidebarWidth() { return Math.max(140, Math.min(180, width / 4)); }
    private int sidebarRight() { return MARGIN + sidebarWidth(); }
    private int panelLeft() { return sidebarRight() + COLUMN_GAP; }
    private int panelRight() { return width - MARGIN; }
    private int panelWidth() { return panelRight() - panelLeft(); }
    private int panelCenter() { return panelLeft() + panelWidth() / 2; }
    private int filterY() { return HEADER_HEIGHT + GAP; }
    private int tableHeaderY() { return filterY() + 28; }
    private int rowsY() { return tableHeaderY() + 12; }
    private int footerY() { return height - MARGIN - 20; }
    /** The pager, right-aligned in the footer: "<", the page label, ">". */
    private int pagerLeft() { return panelRight() - PAGE_BUTTON_WIDTH - PAGE_LABEL_WIDTH - PAGE_BUTTON_WIDTH; }

    private int rowCapacity() {
        return Math.max(1, (footerY() - GAP - rowsY()) / ROW_HEIGHT);
    }

    /**
     * The name column takes what the stats columns leave. Those start at the
     * name column's right edge: pass rate 105px, record 92px, average 74px,
     * then recent outcomes; the last shown column is sized to its content.
     */
    private int scenarioColumnWidth() {
        return panelWidth() - (showRecentForm() ? 360 : showAverage() ? 275 : showRecord() ? 197 : 100);
    }

    private int folderCount() { return api.snapshot().categories().size() + 1; }
    /** Rows that fit under the folder button, leaving room for the hint line below them. */
    private int folderCapacity() { return Math.max(1, Math.min(10, (height - folderListY() - 30) / FOLDER_ROW_HEIGHT)); }
    private int folderListY() { return filterY() + 22; }
    private int folderWidth() { return Math.min(Math.max(200, categoryButton.getWidth()), width - 2 * MARGIN); }
    /** The folder list opens under its button, shifted left if it would run off the screen. */
    private int folderX() { return Math.max(MARGIN, Math.min(categoryButton.getX(), width - MARGIN - folderWidth())); }

    private String folderName(int index) {
        if (index == 0) return "All folders (" + api.snapshot().scenarios().size() + ")";
        LabApiClient.Category folder = api.snapshot().categories().get(index - 1);
        return folder.name() + " (" + folder.scenarios().size() + ")";
    }

    private void renderFolders(GuiGraphics graphics, int mouseX, int mouseY) {
        int x = folderX();
        int y = folderListY();
        int rows = Math.min(folderCapacity(), folderCount());
        graphics.pose().pushPose();
        graphics.pose().translate(0, 0, 300);
        graphics.fill(x - 2, y - 2, x + folderWidth() + 2, y + rows * FOLDER_ROW_HEIGHT + 18, 0xFF6D839F);
        graphics.fill(x, y, x + folderWidth(), y + rows * FOLDER_ROW_HEIGHT + 16, 0xFF172337);
        for (int row = 0; row < rows; row++) {
            int index = folderOffset + row;
            if (index >= folderCount()) break;
            int rowY = y + row * FOLDER_ROW_HEIGHT;
            boolean hover = mouseX >= x && mouseX < x + folderWidth() && mouseY >= rowY && mouseY < rowY + FOLDER_ROW_HEIGHT;
            if (hover || index == folderCursor) graphics.fill(x, rowY, x + folderWidth() - 5, rowY + FOLDER_ROW_HEIGHT, 0xFF354F70);
            graphics.drawString(font, fitWidth(folderName(index), folderWidth() - 14), x + 6, rowY + 6, TEXT, false);
        }
        if (folderCount() > rows) {
            int thumb = Math.max(10, rows * FOLDER_ROW_HEIGHT * rows / folderCount());
            int offset = (rows * FOLDER_ROW_HEIGHT - thumb) * folderOffset / (folderCount() - rows);
            graphics.fill(x + folderWidth() - 4, y + offset, x + folderWidth() - 1, y + offset + thumb, MUTED);
        }
        graphics.drawString(font, "Scroll or use arrow keys / Enter", x + 6, y + rows * FOLDER_ROW_HEIGHT + 4, MUTED, false);
        graphics.pose().popPose();
    }

    private void chooseFolder(int index) {
        category = index == 0 ? null : api.snapshot().categories().get(index - 1).name();
        page = 0;
        folderOpen = false;
        rebuildWidgets();
    }

    @Override
    public boolean mouseClicked(double x, double y, int button) {
        if (folderOpen) {
            int row = (int) ((y - folderListY()) / FOLDER_ROW_HEIGHT);
            if (x >= folderX() && x < folderX() + folderWidth()
                    && y >= folderListY() && row < folderCapacity() && folderOffset + row < folderCount()) {
                chooseFolder(folderOffset + row);
            } else folderOpen = false;
            return true;
        }
        return super.mouseClicked(x, y, button);
    }

    @Override
    public boolean mouseScrolled(double x, double y, double deltaX, double deltaY) {
        if (!folderOpen) {
            // Scrolling over the list turns its pages.
            if (x >= panelLeft() && y >= rowsY() && y < footerY() && deltaY != 0) {
                changePage(deltaY < 0 ? 1 : -1);
                return true;
            }
            return super.mouseScrolled(x, y, deltaX, deltaY);
        }
        folderOffset = Math.max(0, Math.min(Math.max(0, folderCount() - folderCapacity()), folderOffset - (int) Math.signum(deltaY) * 3));
        folderCursor = Math.max(folderOffset, Math.min(folderOffset + folderCapacity() - 1, folderCursor));
        return true;
    }

    @Override
    public boolean keyPressed(int key, int scan, int modifiers) {
        if (folderOpen) {
            if (key == GLFW.GLFW_KEY_ESCAPE) folderOpen = false;
            else if (key == GLFW.GLFW_KEY_ENTER || key == GLFW.GLFW_KEY_KP_ENTER) chooseFolder(folderCursor);
            else {
                if (key == GLFW.GLFW_KEY_DOWN) folderCursor++;
                if (key == GLFW.GLFW_KEY_UP) folderCursor--;
                if (key == GLFW.GLFW_KEY_HOME) folderCursor = 0;
                if (key == GLFW.GLFW_KEY_END) folderCursor = folderCount() - 1;
                folderCursor = Math.max(0, Math.min(folderCount() - 1, folderCursor));
                folderOffset = Math.max(0, Math.min(folderCursor, Math.max(folderOffset, folderCursor - folderCapacity() + 1)));
            }
            return true;
        }
        return super.keyPressed(key, scan, modifiers);
    }

    /** Stats columns appear as the panel widens, after a scenario name has room. */
    private boolean showRecord() {
        return panelWidth() >= 340;
    }

    private boolean showAverage() {
        return panelWidth() >= 430;
    }

    private boolean showRecentForm() {
        return panelWidth() >= 560;
    }

    private Component tabLabel(String label, View target) {
        return Component.literal(view == target ? "[ " + label + " ]" : label);
    }

    @Override
    public boolean isPauseScreen() {
        return false;
    }

    private static int outcomeColor(String outcome) {
        return switch (outcome) {
            case "pass" -> GOOD;
            case "cancelled" -> MUTED;
            default -> BAD;
        };
    }

    private static String duration(int elapsedMs) {
        if (elapsedMs <= 0) return "—";
        return String.format(Locale.ROOT, "%.1fs", elapsedMs / 1000.0);
    }

    private static String age(String timestamp) {
        try {
            long seconds = Math.max(0, Duration.between(Instant.parse(timestamp), Instant.now()).toSeconds());
            if (seconds < 60) return seconds + "s";
            if (seconds < 3600) return (seconds / 60) + "m";
            if (seconds < 86_400) return (seconds / 3600) + "h";
            return (seconds / 86_400) + "d";
        } catch (RuntimeException error) {
            return "—";
        }
    }

    private String fitWidth(String value, int maximumWidth) {
        String text = singleLine(value);
        if (font.width(text) <= maximumWidth) return text;
        while (!text.isEmpty() && font.width(text + "...") > maximumWidth) {
            text = text.substring(0, text.length() - 1);
        }
        return text + "...";
    }

    private static String singleLine(String value) {
        return value == null ? "" : value.replaceAll("\\s+", " ").trim();
    }

    private enum View {
        OVERVIEW,
        RECENT
    }
}
