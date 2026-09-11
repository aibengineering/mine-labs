package dev.minelabs.ui;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphics;

final class LabHud {
    private static final int PANEL = 0xE0141824;
    private static final int BORDER = 0xFF73A7FF;
    private static final int TITLE = 0xFFF4F8FF;
    private static final int TEXT = 0xFFDDE8FA;
    private static final int MUTED = 0xFF91A0B8;
    private static final int GOOD = 0xFF79D99A;
    private static final int WARN = 0xFFFFC857;
    private static final int BAD = 0xFFFF7070;

    private LabHud() {
    }

    static void render(GuiGraphics graphics, DeltaTracker deltaTracker) {
        Minecraft minecraft = Minecraft.getInstance();
        if (minecraft.player == null || minecraft.options.hideGui) return;
        draw(graphics, minecraft.font, lines(ClientEvents.api().snapshot()));
    }

    private static List<Line> lines(LabApiClient.Snapshot snapshot) {
        List<Line> lines = new ArrayList<>();
        String phase = snapshot.phase().toUpperCase(Locale.ROOT);
        lines.add(new Line("MINE LABS  /  " + phase, snapshot.available() ? TITLE : WARN));
        if (snapshot.active() != null) {
            LabApiClient.Active active = snapshot.active();
            lines.add(new Line(
                    "Running  " + active.scenario() + "  /  " + (active.scenarioIndex() + 1) + "/" + active.scenarioCount(),
                    TEXT));
            lines.add(new Line("Cycle    " + active.cycle() + "  /  elapsed " + age(active.startedAt()), MUTED));
            if (!active.goalText().isBlank()) {
                lines.add(new Line("Goals    F10 > Scenario details", GOOD));
            }
        } else {
            lines.add(new Line(snapshot.message(), snapshot.available() ? MUTED : WARN));
        }
        LabApiClient.Totals totals = snapshot.totals();
        lines.add(new Line(
                "Last 15  " + totals.runs() + " runs  /  " + totals.passed() + " pass  /  " + totals.failed() + " fail",
                totals.failed() > 0 ? WARN : GOOD));
        if (!snapshot.recent().isEmpty()) {
            LabApiClient.Result last = snapshot.recent().get(0);
            lines.add(new Line(
                    "Latest   " + last.scenario() + "  /  " + last.outcome().toUpperCase(Locale.ROOT),
                    outcomeColor(last.outcome())));
        }
        lines.add(new Line("F10 dashboard  /  loop mode, skip, select, stop", MUTED));
        return lines;
    }

    private static void draw(GuiGraphics graphics, Font font, List<Line> lines) {
        int maximumWidth = Math.min(360, graphics.guiWidth() - 16);
        int contentWidth = lines.stream().mapToInt(line -> font.width(line.text)).max().orElse(0) + 18;
        int width = Math.min(maximumWidth, Math.max(245, contentWidth));
        int x = graphics.guiWidth() - width - 8;
        int y = 8;
        int lineHeight = 11;
        int height = 12 + lines.size() * lineHeight;
        graphics.fill(x, y, x + width, y + height, PANEL);
        graphics.renderOutline(x, y, width, height, BORDER);
        graphics.fill(x + width - 3, y, x + width, y + height, BORDER);
        for (int index = 0; index < lines.size(); index++) {
            Line line = lines.get(index);
            graphics.drawString(font, fit(font, line.text, width - 18), x + 8, y + 7 + index * lineHeight, line.color, false);
        }
    }

    private static int outcomeColor(String outcome) {
        return switch (outcome) {
            case "pass" -> GOOD;
            case "cancelled" -> MUTED;
            case "fail", "error", "timeout" -> BAD;
            default -> TEXT;
        };
    }

    private static String age(String timestamp) {
        try {
            long seconds = Math.max(0, Duration.between(Instant.parse(timestamp), Instant.now()).toSeconds());
            return seconds < 60 ? seconds + "s" : (seconds / 60) + "m";
        } catch (RuntimeException error) {
            return "?";
        }
    }

    private static String fit(Font font, String value, int width) {
        String text = value == null ? "" : value.replace("\r", " ").replace("\n", " ").trim();
        if (font.width(text) <= width) return text;
        while (!text.isEmpty() && font.width(text + "...") > width) text = text.substring(0, text.length() - 1);
        return text + "...";
    }

    private static String singleLine(String value) {
        return value == null ? "" : value.replaceAll("\\s+", " ").trim();
    }

    private record Line(String text, int color) {
    }
}
