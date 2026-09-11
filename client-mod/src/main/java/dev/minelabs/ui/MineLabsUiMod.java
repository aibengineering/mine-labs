package dev.minelabs.ui;

import com.mojang.logging.LogUtils;
import net.minecraft.resources.ResourceLocation;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.client.event.RegisterGuiLayersEvent;
import net.neoforged.neoforge.common.NeoForge;
import org.slf4j.Logger;

@Mod(MineLabsUiMod.MOD_ID)
public final class MineLabsUiMod {
    static final String MOD_ID = "mine_labs_ui";
    static final Logger LOGGER = LogUtils.getLogger();

    public MineLabsUiMod(IEventBus modEventBus) {
        modEventBus.addListener(MineLabsUiMod::registerGuiLayers);
        modEventBus.addListener(ClientEvents::registerKeyMappings);
        NeoForge.EVENT_BUS.register(ClientEvents.class);
    }

    private static void registerGuiLayers(RegisterGuiLayersEvent event) {
        event.registerAboveAll(
                ResourceLocation.fromNamespaceAndPath(MOD_ID, "test_status"),
                LabHud::render);
    }
}
