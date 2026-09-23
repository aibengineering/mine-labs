package dev.minelabs.ui;

import java.io.IOException;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/**
 * Where a player's own client is told which lab to use.
 *
 * Tailscale remote mode prints the address to enter, such as
 * {@code http://100.101.102.103:25578}; a bare host or host:port works too.
 * The address is saved, so later launches go straight to the dashboard.
 */
final class LabAddressScreen extends Screen {
    private static final int TEXT = 0xFFE0E0E0;
    private static final int MUTED = 0xFFA0A0A0;
    private static final int BAD = 0xFFFF7070;
    private final LabApiClient api;
    private final Screen parent;
    private EditBox address;
    private String error = "";

    LabAddressScreen(LabApiClient api, Screen parent) {
        super(Component.literal("Mine Labs lab address"));
        this.api = api;
        this.parent = parent;
    }

    @Override
    protected void init() {
        int fieldWidth = Math.min(300, width - 40);
        int left = (width - fieldWidth) / 2;
        String current = address == null ? LabConfig.savedUrl() : address.getValue();
        address = addRenderableWidget(new EditBox(font, left, height / 2 - 10, fieldWidth, 20, Component.literal("Lab address")));
        address.setMaxLength(200);
        address.setHint(Component.literal("http://100.x.y.z:25578"));
        address.setValue(current);
        setInitialFocus(address);
        int buttonWidth = (fieldWidth - 8) / 2;
        addRenderableWidget(Button.builder(Component.literal("Connect"), button -> connect())
                .bounds(left, height / 2 + 20, buttonWidth, 20).build());
        addRenderableWidget(Button.builder(Component.literal("Cancel"), button -> onClose())
                .bounds(left + buttonWidth + 8, height / 2 + 20, buttonWidth, 20).build());
    }

    private void connect() {
        String url = LabConfig.normalize(address.getValue());
        if (url == null) {
            error = "Enter an http address, such as http://100.101.102.103:25578";
            return;
        }
        try {
            LabConfig.saveUrl(url);
        } catch (IOException failure) {
            MineLabsUiMod.LOGGER.warn("Could not save the Mine Labs lab address", failure);
            error = "Could not save the address: " + failure.getMessage();
            return;
        }
        api.setBaseUrl(url);
        ClientEvents.labAddressSaved();
        minecraft.setScreen(ClientEvents.dashboard());
    }

    @Override
    public boolean keyPressed(int keyCode, int scanCode, int modifiers) {
        // Enter confirms from the text field, as on the multiplayer "Direct Connection" screen.
        if (keyCode == 257 || keyCode == 335) {
            connect();
            return true;
        }
        return super.keyPressed(keyCode, scanCode, modifiers);
    }

    @Override
    public void onClose() {
        minecraft.setScreen(parent);
    }

    @Override
    public void render(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
        super.render(graphics, mouseX, mouseY, partialTick);
        graphics.drawCenteredString(font, title, width / 2, height / 2 - 52, TEXT);
        graphics.drawCenteredString(font, Component.literal("Enter the address mine-labs printed in Tailscale remote mode."),
                width / 2, height / 2 - 34, MUTED);
        if (!error.isEmpty()) graphics.drawCenteredString(font, Component.literal(error), width / 2, height / 2 + 48, BAD);
    }
}
