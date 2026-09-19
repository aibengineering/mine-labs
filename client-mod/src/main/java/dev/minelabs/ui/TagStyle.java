package dev.minelabs.ui;

import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;

/** Tags are suite-owned labels, not Mine Labs test types or result states. */
final class TagStyle {
    // Avoid pass/fail green and red. Hash the label so catalog order and filtering
    // cannot change its color; labels may share a color, so always show their text.
    private static final int[] COLORS = {
            0xEBC779, 0x83D5E8, 0xB9AFF0, 0x91BAF5, 0xDDD1A1, 0xD7A6FF, 0xB1C9DC
    };

    private TagStyle() {}

    static int color(String tag) {
        return COLORS[Math.floorMod(tag.hashCode(), COLORS.length)];
    }

    static MutableComponent badge(String tag) {
        return Component.literal("[" + tag + "]").withStyle(style -> style.withColor(color(tag)));
    }
}
