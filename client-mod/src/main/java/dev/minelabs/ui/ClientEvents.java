package dev.minelabs.ui;

import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.PauseScreen;
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
    private static final boolean MANAGED = Boolean.getBoolean("minelabs.managed");
    private static boolean openedDashboard;
    private static String connectionId;
    private static final KeyMapping OPEN_DASHBOARD = new KeyMapping(
            "key.mine_labs_ui.open",
            InputConstants.Type.KEYSYM,
            GLFW.GLFW_KEY_F10,
            "key.categories.mine_labs_ui");

    private static final KeyMapping OPEN_DETAILS = new KeyMapping(
            "key.mine_labs_ui.details", InputConstants.Type.KEYSYM, GLFW.GLFW_KEY_F9,
            "key.categories.mine_labs_ui");

    static String detailsKeyLabel() { return OPEN_DETAILS.getTranslatedKeyMessage().getString(); }

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
    }

    @SubscribeEvent
    public static void onScreenOpening(ScreenEvent.Opening event) {
        if (MANAGED && !openedDashboard && event.getNewScreen() instanceof TitleScreen) {
            openedDashboard = true;
            event.setNewScreen(DASHBOARD);
            MineLabsUiMod.LOGGER.info("Mine Labs dashboard opened");
        }
    }

    @SubscribeEvent
    public static void onScreenInit(ScreenEvent.Init.Post event) {
        if (event.getScreen() instanceof TitleScreen screen) {
            event.addListener(Button.builder(Component.literal("Mine Labs"), button ->
                    Minecraft.getInstance().setScreen(DASHBOARD))
                    .bounds(10, 10, 100, 20).build());
        }
        if (event.getScreen() instanceof PauseScreen) {
            event.addListener(Button.builder(Component.literal("Mine Labs (F10)"), button ->
                    Minecraft.getInstance().setScreen(DASHBOARD))
                    .bounds(10, 10, 125, 20).build());
            if (MANAGED) event.addListener(Button.builder(Component.literal("Return to Labs"), button -> returnToLabs())
                    .bounds(10, 34, 125, 20).build());
            Button teleport = Button.builder(Component.literal("Teleport to bot"), button -> teleportToBot())
                    .bounds(10, 58, 125, 20).build();
            teleport.active = canTeleportToBot();
            if (MANAGED) event.addListener(teleport);
        }
    }

    @SubscribeEvent
    public static void onScreenKey(ScreenEvent.KeyPressed.Pre event) {
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
        return MANAGED && target != null && target.id().equals(connectionId)
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
        if (MANAGED && openedDashboard && snapshot.available()) {
            LabApiClient.Connection target = snapshot.connection();
            if (target == null && connectionId != null) {
                connectionId = null;
                minecraft.disconnect(DASHBOARD);
            } else if (target != null && !target.id().equals(connectionId)) {
                connectionId = target.id();
                if (minecraft.level != null) minecraft.disconnect(DASHBOARD);
                Screen parent = DASHBOARD;
                MineLabsUiMod.LOGGER.info("Mine Labs connecting to {} ({})", target.address(), target.id());
                ConnectScreen.startConnecting(parent, minecraft, ServerAddress.parseString(target.address()),
                        new ServerData("Mine Labs", target.address(), ServerData.Type.OTHER), false, null);
            }
        }
        while (OPEN_DETAILS.consumeClick()) toggleDetails();
        while (OPEN_DASHBOARD.consumeClick()) {
            minecraft.setScreen(DASHBOARD);
        }
    }

    static LabApiClient api() {
        return API;
    }
}
