package dev.minelabs.ui;

import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/** Immediate acknowledgement of selection, retained throughout world preparation. */
final class LabLoadingScreen extends Screen {
    private final LabApiClient api;
    private final String scenario;
    private Button cancel;

    LabLoadingScreen(LabApiClient api, String scenario) {
        super(Component.literal("Mine Labs"));
        this.api = api;
        this.scenario = scenario;
    }

    @Override
    protected void init() {
        cancel = addRenderableWidget(Button.builder(Component.literal("Return to Labs"), button -> ClientEvents.returnToLabs())
                .bounds(width / 2 - 70, height / 2 + 70, 140, 20).build());
    }

    @Override
    public void tick() {
        String phase = api.snapshot().phase();
        cancel.active = api.pendingAction() == null && !phase.equals("returning");
        if (api.pendingAction() == null && (!api.snapshot().available() || api.controlFailed()
                || (!phase.equals("preparing") && !phase.equals("returning")))) {
            minecraft.setScreen((phase.equals("running") || phase.equals("ready")) && minecraft.level != null ? null : ClientEvents.dashboard());
        }
    }

    @Override
    public void renderBackground(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
        graphics.fill(0, 0, width, height, 0xFF101726);
    }

    @Override
    public void render(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
        super.render(graphics, mouseX, mouseY, partialTick);
        boolean returning = "menu".equals(api.pendingAction()) || api.snapshot().phase().equals("returning");
        int center = width / 2;
        int top = height / 2 - 62;
        graphics.drawCenteredString(font, returning ? "RETURNING TO MINE LABS" : "PREPARING YOUR SCENARIO", center, top, 0xFF79D9FF);
        int y = top + 24;
        for (var line : font.split(Component.literal(scenario), Math.min(480, width - 48))) {
            graphics.drawCenteredString(font, line, center, y, 0xFFF4F8FF);
            y += 12;
        }
        int barY = Math.max(y + 16, height / 2 + 4);
        int barWidth = Math.min(320, width - 48);
        int left = center - barWidth / 2;
        graphics.fill(left, barY, left + barWidth, barY + 5, 0xFF273143);
        int offset = (int) ((System.currentTimeMillis() / 6) % (barWidth - 50));
        graphics.fill(left + offset, barY, left + offset + 50, barY + 5, 0xFF79D9FF);
        String detail = api.pendingAction() != null ? "Selection received..." : api.snapshot().message();
        graphics.drawCenteredString(font, font.plainSubstrByWidth(detail, width - 40), center, barY + 18, 0xFFB6C5DD);
    }

    @Override public boolean isPauseScreen() { return false; }
    @Override public boolean shouldCloseOnEsc() { return false; }
}
