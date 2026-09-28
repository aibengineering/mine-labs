package dev.minelabs.ui;

import com.mojang.blaze3d.platform.InputConstants;
import java.util.List;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.PauseScreen;
import net.minecraft.client.gui.screens.multiplayer.JoinMultiplayerScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.network.chat.Component;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.client.event.RegisterKeyMappingsEvent;
import net.neoforged.neoforge.client.event.ScreenEvent;
import org.lwjgl.glfw.GLFW;

final class ClientEvents {
    private static final LabApiClient API = new LabApiClient();
    private static final LabScreen DASHBOARD = new LabScreen(API);
    /**
     * A managed client is launched by Mine Labs; a player's own client, such as
     * a phone in Tailscale remote mode, becomes one once it has a saved lab address.
     */
    static boolean managed() {
        return Boolean.getBoolean("minelabs.managed") || !LabConfig.savedUrl().isEmpty();
    }
    private static boolean openedDashboard;
    private static String connectionId;
    private static final KeyMapping OPEN_DASHBOARD = new KeyMapping(
            "key.mine_labs_ui.open",
            InputConstants.Type.KEYSYM,
            GLFW.GLFW_KEY_F10,
            "key.categories.mine_labs_ui");

    static String dashboardKeyLabel() { return OPEN_DASHBOARD.getTranslatedKeyMessage().getString(); }

    private static final KeyMapping OPEN_DETAILS = new KeyMapping(
            "key.mine_labs_ui.details", InputConstants.Type.KEYSYM, GLFW.GLFW_KEY_F9,
            "key.categories.mine_labs_ui");

    static String detailsKeyLabel() { return OPEN_DETAILS.getTranslatedKeyMessage().getString(); }

    private static final KeyMapping START_SCENARIO = new KeyMapping(
            "key.mine_labs_ui.start", InputConstants.Type.KEYSYM, GLFW.GLFW_KEY_F8,
            "key.categories.mine_labs_ui");

    static String startKeyLabel() { return START_SCENARIO.getTranslatedKeyMessage().getString(); }

    static void startScenario() {
        if (API.snapshot().awaitingStartTrialId().isBlank() || API.pendingAction() != null) return;
        API.startScenario();
        Minecraft.getInstance().setScreen(null);
    }

    private static void toggleDetails() {
        Minecraft minecraft = Minecraft.getInstance();
        if (minecraft.screen instanceof LabDetailsScreen details) { details.onClose(); return; }
        String scenario = API.snapshot().currentScenario();
        if (!scenario.isBlank()) {
            // Remember the caller so a quick inspection returns directly to the world.
            minecraft.setScreen(new LabDetailsScreen(API, scenario, true, minecraft.screen));
        } else if (minecraft.player != null) {
            minecraft.player.displayClientMessage(Component.literal("No scenario has run yet. Choose one in Mine Labs."), true);
        }
    }

    private ClientEvents() {
    }

    static LabScreen dashboard() { return DASHBOARD; }

    static void registerKeyMappings(RegisterKeyMappingsEvent event) {
        event.register(OPEN_DASHBOARD);
        event.register(OPEN_DETAILS);
        event.register(START_SCENARIO);
    }

    @SubscribeEvent
    public static void onScreenOpening(ScreenEvent.Opening event) {
        if (managed() && !openedDashboard && event.getNewScreen() instanceof TitleScreen) {
            openedDashboard = true;
            event.setNewScreen(DASHBOARD);
            MineLabsUiMod.LOGGER.info("Mine Labs dashboard opened");
        }
    }

    /**
     * Open the dashboard from a menu button, which is how a touch client gets
     * there: F10 needs a keyboard. A player's own client has nowhere to connect
     * until it is given a lab address, so that screen comes first. A launch
     * property already names the lab, and would override a typed address anyway.
     */
    private static Button dashboardButton(Screen parent, int x, int y, int width) {
        boolean hasLab = managed() || LabConfig.launchedWithUrl();
        return Button.builder(Component.literal("Mine Labs"), button ->
                Minecraft.getInstance().setScreen(hasLab ? DASHBOARD : new LabAddressScreen(API, parent)))
                .bounds(x, y, width, 20).build();
    }

    /**
     * The bottom edge of the screen's own menu buttons. Added buttons go under
     * them rather than in a corner, where mobile launchers such as Amethyst draw
     * their on-screen controls. Text along the bottom edge, such as the title
     * screen's copyright line, is not part of the menu.
     */
    private static int menuBottom(Screen screen, List<GuiEventListener> listeners) {
        int bottom = screen.height / 4;
        for (GuiEventListener listener : listeners) {
            if (listener instanceof AbstractWidget widget && widget.visible && widget.getY() + widget.getHeight() <= screen.height - 20) {
                bottom = Math.max(bottom, widget.getY() + widget.getHeight());
            }
        }
        return bottom;
    }

    @SubscribeEvent
    public static void onScreenInit(ScreenEvent.Init.Post event) {
        Screen screen = event.getScreen();
        if (screen instanceof TitleScreen) {
            int y = Math.min(menuBottom(screen, event.getListenersList()) + 8, screen.height - 34);
            event.addListener(dashboardButton(screen, screen.width / 2 - 100, y, 200));
        }
        if (screen instanceof JoinMultiplayerScreen) {
            // Beside the footer's upper row, where players look to connect.
            int rowY = Integer.MAX_VALUE;
            int left = screen.width / 2 - 154;
            for (GuiEventListener listener : event.getListenersList()) {
                if (listener instanceof AbstractWidget widget && widget.visible && widget.getY() >= screen.height - 64) {
                    if (widget.getY() < rowY) { rowY = widget.getY(); left = widget.getX(); }
                    else if (widget.getY() == rowY) left = Math.min(left, widget.getX());
                }
            }
            if (rowY == Integer.MAX_VALUE) rowY = screen.height - 52;
            event.addListener(dashboardButton(screen, Math.max(4, left - 84), rowY, 80));
        }
        if (screen instanceof PauseScreen) {
            int y = menuBottom(screen, event.getListenersList()) + 8;
            if (!managed()) {
                event.addListener(dashboardButton(screen, screen.width / 2 - 49, y, 98));
                return;
            }
            // One row under the pause menu, reached with Amethyst's on-screen Pause button.
            int left = screen.width / 2 - 151;
            event.addListener(dashboardButton(screen, left, y, 98));
            event.addListener(Button.builder(Component.literal("Return to Labs"), button -> returnToLabs())
                    .bounds(left + 102, y, 98, 20).build());
            Button teleport = Button.builder(Component.literal("Teleport to bot"), button -> teleportToBot())
                    .bounds(left + 204, y, 98, 20).build();
            teleport.active = canTeleportToBot();
            event.addListener(teleport);
        }
    }

    @SubscribeEvent
    public static void onScreenKey(ScreenEvent.KeyPressed.Pre event) {
        if (START_SCENARIO.matches(event.getKeyCode(), event.getScanCode())) {
            event.setCanceled(true);
            startScenario();
            return;
        }
        if (OPEN_DETAILS.matches(event.getKeyCode(), event.getScanCode())) {
            event.setCanceled(true);
            toggleDetails();
            return;
        }
        if (OPEN_DASHBOARD.matches(event.getKeyCode(), event.getScanCode())) {
            event.setCanceled(true);
            if (event.getScreen() instanceof LabScreen screen) screen.onClose();
            else Minecraft.getInstance().setScreen(DASHBOARD);
        }
    }

    /** A newly saved address makes this a managed client now, not after a restart. */
    static void labAddressSaved() {
        openedDashboard = true;
        connectionId = null;
    }

    static void returnToLabs() {
        API.control("menu", null);
        Minecraft.getInstance().setScreen(new LabLoadingScreen(API, "Returning to Mine Labs"));
    }

    static void selectScenario(String scenario) {
        API.control("select", scenario);
        Minecraft.getInstance().setScreen(new LabLoadingScreen(API, scenario));
    }

    static void reconnect() {
        connectionId = null;
    }

    static boolean canTeleportToBot() {
        Minecraft minecraft = Minecraft.getInstance();
        LabApiClient.Connection target = API.snapshot().connection();
        return managed() && target != null && target.id().equals(connectionId)
                && minecraft.player != null && minecraft.player.isSpectator()
                && minecraft.getConnection() != null && !target.focusPlayer().isBlank()
                && minecraft.getConnection().getPlayerInfo(target.focusPlayer()) != null;
    }

    static void teleportToBot() {
        if (!canTeleportToBot()) return;
        Minecraft minecraft = Minecraft.getInstance();
        String player = API.snapshot().connection().focusPlayer();
        minecraft.getConnection().sendCommand("execute at " + player
                + " rotated ~ 0 run tp @s ^ ^4 ^-6 ~ 33.69");
        minecraft.setScreen(null);
    }

    @SubscribeEvent
    public static void onClientTick(ClientTickEvent.Post event) {
        Minecraft minecraft = Minecraft.getInstance();
        API.tick();
        LabApiClient.Snapshot snapshot = API.snapshot();
        if (managed() && openedDashboard && snapshot.available()) {
            LabApiClient.Connection target = snapshot.connection();
            if (target == null && connectionId != null) {
                connectionId = null;
                minecraft.disconnect(DASHBOARD);
            } else if (target != null && !target.id().equals(connectionId)) {
                connectionId = target.id();
                if (minecraft.level != null) minecraft.disconnect(DASHBOARD);
                MineLabsUiMod.LOGGER.info("Mine Labs connecting to {} ({})", target.address(), target.id());
                ConnectScreen.startConnecting(DASHBOARD, minecraft, ServerAddress.parseString(target.address()),
                        new ServerData("Mine Labs", target.address(), ServerData.Type.OTHER), false, null);
            }
        }
        while (OPEN_DETAILS.consumeClick()) toggleDetails();
        while (START_SCENARIO.consumeClick()) startScenario();
        while (OPEN_DASHBOARD.consumeClick()) {
            minecraft.setScreen(DASHBOARD);
        }
    }

    static LabApiClient api() {
        return API;
    }
}
