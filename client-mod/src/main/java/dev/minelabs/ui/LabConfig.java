package dev.minelabs.ui;

import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;
import net.neoforged.fml.loading.FMLPaths;

/**
 * The lab address a player's own client remembers between launches.
 *
 * A managed client is launched with its address as a JVM property. A client in
 * someone's own launcher, such as a phone connecting in Tailscale remote mode,
 * cannot rely on JVM arguments, so the address typed into the dashboard is kept
 * here instead. A launch property always wins over the saved address.
 */
final class LabConfig {
    private static final String URL_KEY = "labUrl";
    private static final Path FILE = FMLPaths.CONFIGDIR.get().resolve("mine_labs_ui.properties");
    /** Read once; the dashboard asks every frame. */
    private static volatile String saved = load();

    private LabConfig() {
    }

    static boolean launchedWithUrl() {
        return System.getProperty("minelabs.uiUrl") != null;
    }

    /** The saved address, or an empty string when none has been entered. */
    static String savedUrl() {
        return saved;
    }

    private static String load() {
        Properties properties = new Properties();
        if (!Files.isRegularFile(FILE)) return "";
        try (Reader reader = Files.newBufferedReader(FILE, StandardCharsets.UTF_8)) {
            properties.load(reader);
        } catch (IOException error) {
            MineLabsUiMod.LOGGER.warn("Could not read {}", FILE, error);
            return "";
        }
        String url = normalize(properties.getProperty(URL_KEY, ""));
        return url == null ? "" : url;
    }

    static void saveUrl(String url) throws IOException {
        Properties properties = new Properties();
        properties.setProperty(URL_KEY, url);
        Files.createDirectories(FILE.getParent());
        try (Writer writer = Files.newBufferedWriter(FILE, StandardCharsets.UTF_8)) {
            properties.store(writer, "Mine Labs lab address");
        }
        saved = url;
    }

    /**
     * Accept what a person is likely to type: a bare host, a host and port, or
     * a full URL. Returns null for anything that is not an http address.
     */
    static String normalize(String input) {
        String value = input == null ? "" : input.trim();
        if (value.isEmpty()) return null;
        if (!value.contains("://")) value = "http://" + value;
        try {
            URI uri = URI.create(value);
            if (!"http".equals(uri.getScheme()) || uri.getHost() == null) return null;
            int port = uri.getPort() == -1 ? 25578 : uri.getPort();
            return "http://" + uri.getHost() + ":" + port;
        } catch (IllegalArgumentException invalid) {
            return null;
        }
    }
}
