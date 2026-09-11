package dev.minelabs.ui;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import net.minecraft.util.FormattedCharSequence;
import org.lwjgl.glfw.GLFW;

/** Scrollable full conditions, separate from the compact in-world HUD. */
final class LabDetailsScreen extends Screen {
    private static final int TEXT = 0xFFDDE8FA, MUTED = 0xFF91A0B8, GOOD = 0xFF79D99A, BAD = 0xFFFF7070;
    private final LabApiClient api;
    private final String scenario;
    private final boolean current;
    private JsonObject details;
    private String error = "";
    private boolean fetching;
    private long nextPoll;
    private int tab;
    private int scroll;
    private List<Line> lines = List.of();
    private boolean dirty = true;
    private Button run;

    LabDetailsScreen(LabApiClient api, String scenario, boolean current) {
        super(Component.literal("Scenario details"));
        this.api = api; this.scenario = scenario; this.current = current;
    }

    @Override protected void init() {
        dirty = true;
        String[] labels = {"Goals", "Starting setup", "Driver parameters"};
        int buttonWidth = Math.min(145, (width - 32) / 3);
        for (int index = 0; index < labels.length; index++) {
            final int selected = index;
            addRenderableWidget(Button.builder(Component.literal((tab == index ? "[ " : "") + labels[index] + (tab == index ? " ]" : "")),
                    button -> {tab = selected; scroll = 0; rebuildWidgets();})
                    .bounds(width / 2 - buttonWidth * 3 / 2 + index * buttonWidth, 48, buttonWidth - 4, 20).build());
        }
        addRenderableWidget(Button.builder(Component.literal("Back to dashboard"), button -> onClose())
                .bounds(16, height - 30, 145, 20).build());
        run = addRenderableWidget(Button.builder(Component.literal(current ? "Run again" : "Run scenario"), button -> ClientEvents.selectScenario(displayedScenario()))
                .bounds(width - 136, height - 30, 120, 20).build());
    }

    @Override public void tick() {
        run.active = api.pendingAction() == null && api.snapshot().scenarios().contains(displayedScenario());
        if (fetching || System.currentTimeMillis() < nextPoll || (!current && details != null)) return;
        fetching = true;
        nextPoll = System.currentTimeMillis() + 500;
        api.inspectScenario(scenario, current).whenComplete((value, failure) -> minecraft.execute(() -> {
            fetching = false;
            if (failure == null) { details = value; error = ""; dirty = true; }
            else {error = "Could not refresh details. " + (failure.getCause() == null ? failure.getMessage() : failure.getCause().getMessage()); nextPoll = System.currentTimeMillis() + 2000;}
        }));
    }

    private void add(List<Line> output, String text, int color, int indent) {
        for (String paragraph : text.split("\n", -1)) {
            if (paragraph.isEmpty()) output.add(new Line(FormattedCharSequence.EMPTY, color, indent));
            else for (var wrapped : font.split(Component.literal(paragraph), width - 56 - indent)) output.add(new Line(wrapped, color, indent));
        }
    }

    private void goal(List<Line> output, JsonObject node, JsonObject progress, int depth) {
        int indent = Math.min(depth * 14, width / 3);
        String state = progress == null ? "not observed" : text(progress, "state");
        int color = state.equals("passed") ? GOOD : state.equals("failed") ? BAD : TEXT;
        add(output, "[" + state.toUpperCase(java.util.Locale.ROOT) + "] " + text(node, "label"), color, indent);
        if (progress != null) add(output, text(progress, "detail"), MUTED, indent + 8);
        if (node.has("children")) {
            JsonArray children = node.getAsJsonArray("children");
            JsonArray observations = progress != null && progress.has("children") ? progress.getAsJsonArray("children") : new JsonArray();
            for (int index = 0; index < children.size(); index++) goal(output, children.get(index).getAsJsonObject(),
                    index < observations.size() ? observations.get(index).getAsJsonObject() : null, depth + 1);
        }
        add(output, "", MUTED, 0);
    }

    private void rebuildLines() {
        dirty = false;
        List<Line> output = new ArrayList<>();
        if (details == null) { add(output, "Loading scenario conditions...", MUTED, 0); lines = output; return; }
        add(output, text(details, "name"), TEXT, 0);
        add(output, text(details, "description"), MUTED, 0);
        add(output, text(details, "source"), MUTED, 0);
        add(output, "", MUTED, 0);
        if (tab == 0) {
            add(output, "Time limit: " + details.get("timeoutSeconds").getAsInt() + " seconds from scenario start", TEXT, 0);
            if (details.has("outcome")) add(output, "Run: " + text(details, "outcome"), TEXT, 0);
            add(output, "", MUTED, 0);
            goal(output, details.getAsJsonObject("goal"), details.has("progress") ? details.getAsJsonObject("progress") : null, 0);
            add(output, "Statuses are the latest server observations. A completion goal also requires the driver's own checks; YAML does not enumerate those checks.", MUTED, 0);
        } else if (tab == 1) {
            add(output, "Declared starting setup. The driver may arrange additional conditions or change them during the run.", MUTED, 0);
            for (JsonElement entry : details.getAsJsonArray("setup")) {
                JsonObject section = entry.getAsJsonObject();
                add(output, "", MUTED, 0); add(output, text(section, "title"), GOOD, 0);
                JsonArray values = section.getAsJsonArray("lines");
                if (values.isEmpty()) add(output, "None declared.", MUTED, 8);
                for (JsonElement line : values) add(output, line.getAsString(), TEXT, 8);
            }
        } else {
            add(output, "Values passed to the bot driver. Their meaning and additional checks are defined by that driver.", MUTED, 0);
            add(output, "", MUTED, 0);
            for (JsonElement line : details.getAsJsonArray("parameters")) add(output, line.getAsString(), TEXT, 0);
        }
        lines = output;
    }

    @Override public void renderBackground(GuiGraphics graphics, int x, int y, float partialTick) {
        graphics.fill(0, 0, width, height, 0xFF101726);
    }

    @Override public void render(GuiGraphics graphics, int x, int y, float partialTick) {
        super.render(graphics, x, y, partialTick);
        graphics.drawCenteredString(font, title, width / 2, 12, TEXT);
        graphics.drawCenteredString(font, error.isEmpty() ? "Full conditions / scroll to read" : font.plainSubstrByWidth(error, width - 32), width / 2, 28, error.isEmpty() ? MUTED : BAD);
        if (dirty) rebuildLines();
        int visible = Math.max(1, (height - 124) / 13);
        scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.size() - visible)));
        graphics.enableScissor(16, 78, width - 16, height - 44);
        for (int index = scroll; index < Math.min(lines.size(), scroll + visible); index++) {
            Line line = lines.get(index);
            graphics.drawString(font, line.text(), 22 + line.indent(), 82 + (index - scroll) * 13, line.color(), false);
        }
        graphics.disableScissor();
        if (lines.size() > visible) {
            int track = height - 124;
            int thumb = Math.max(12, track * visible / lines.size());
            int offset = (track - thumb) * scroll / (lines.size() - visible);
            graphics.fill(width - 14, 82, width - 10, 82 + track, 0xFF273143);
            graphics.fill(width - 14, 82 + offset, width - 10, 82 + offset + thumb, MUTED);
        }
    }

    @Override public boolean mouseScrolled(double x, double y, double dx, double dy) {scroll -= (int) Math.signum(dy) * 3; return true;}
    @Override public boolean keyPressed(int key, int scan, int modifiers) {
        if (key == GLFW.GLFW_KEY_DOWN) scroll++;
        else if (key == GLFW.GLFW_KEY_UP) scroll--;
        else if (key == GLFW.GLFW_KEY_PAGE_DOWN) scroll += Math.max(1, (height - 124) / 13);
        else if (key == GLFW.GLFW_KEY_PAGE_UP) scroll -= Math.max(1, (height - 124) / 13);
        else if (key == GLFW.GLFW_KEY_HOME) scroll = 0;
        else if (key == GLFW.GLFW_KEY_END) scroll = lines.size();
        else return super.keyPressed(key, scan, modifiers);
        return true;
    }
    @Override public void onClose() {minecraft.setScreen(ClientEvents.dashboard());}
    private String displayedScenario() {return current && details != null ? text(details, "name") : scenario;}
    @Override public boolean isPauseScreen() {return false;}
    private static String text(JsonObject object, String key) {return object.has(key) ? object.get(key).getAsString() : "";}
    private record Line(FormattedCharSequence text, int color, int indent) {}
}
