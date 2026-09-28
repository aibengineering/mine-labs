package dev.minelabs.ui;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.CompletableFuture;
import net.minecraft.client.Minecraft;

final class LabApiClient {
    private static final String DEFAULT_URL = "http://127.0.0.1:" + LabConfig.DEFAULT_PORT;
    private static final long POLL_INTERVAL_MS = 500;
    private static final long FAILURE_GRACE_MS = 2_000;
    private static final int MAX_RESPONSE_CHARS = 1_000_000;
    /** The /api/status shape this mod reads; the lab reports its own as apiVersion. */
    static final int API_VERSION = 1;
    /** Minecraft's username rule, for names sent to and received from the lab. */
    private static final String PLAYER_NAME = "[A-Za-z0-9_]{1,16}";
    /** Properties the JVM was launched with, captured before any lab-supplied value is applied. */
    private static final Properties LAUNCH_PROPERTIES = (Properties) System.getProperties().clone();

    private final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(1))
            .build();
    private volatile String baseUrl = initialUrl();
    private volatile Snapshot snapshot = Snapshot.offline("waiting for Mine Labs");
    private boolean requestInFlight;
    private long nextPollAt;
    private long lastSuccessAt;
    private volatile String pendingAction;
    private volatile String notice = "";
    private volatile boolean controlFailed;
    private long controlGeneration;

    private static String initialUrl() {
        if (LabConfig.launchedWithUrl()) return trimSlash(System.getProperty(LabConfig.URL_PROPERTY));
        String saved = LabConfig.savedUrl();
        return saved.isEmpty() ? DEFAULT_URL : saved;
    }

    String baseUrl() { return baseUrl; }

    /** Point at another lab, such as one typed into the address screen, and start polling it. */
    synchronized void setBaseUrl(String url) {
        baseUrl = trimSlash(url);
        controlGeneration++;
        lastSuccessAt = 0;
        nextPollAt = 0;
        snapshot = Snapshot.offline("Connecting to " + baseUrl);
    }

    /**
     * Every request names the player, so a lab in Tailscale remote mode knows
     * whom to wait for and make an operator. A loopback lab ignores it.
     */
    private HttpRequest.Builder request(String path) {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(baseUrl + path));
        String player = Minecraft.getInstance().getUser().getName();
        if (player != null && player.matches(PLAYER_NAME)) builder.header("X-Mine-Labs-Player", player);
        return builder;
    }

    String pendingAction() { return pendingAction; }
    String notice() { return notice; }
    boolean controlFailed() { return controlFailed; }

    synchronized void tick() {
        long now = System.currentTimeMillis();
        if (requestInFlight || pendingAction != null || now < nextPollAt) return;
        requestInFlight = true;
        nextPollAt = now + POLL_INTERVAL_MS;
        HttpRequest request = request("/api/status")
                .timeout(Duration.ofSeconds(2))
                .header("Accept", "application/json")
                .GET()
                .build();
        long generation = controlGeneration;
        client.sendAsync(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
                .whenComplete((response, error) -> completePoll(response, error, generation));
    }

    Snapshot snapshot() {
        return snapshot;
    }

    CompletableFuture<JsonObject> inspectScenario(String name, boolean current) {
        String query = current ? "current=true" : "name=" + URLEncoder.encode(name, StandardCharsets.UTF_8);
        return client.sendAsync(request("/api/scenario?" + query)
                .timeout(Duration.ofSeconds(5)).GET().build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
                .thenApply(response -> {
                    JsonObject result = JsonParser.parseString(response.body()).getAsJsonObject();
                    if (response.statusCode() != 200) throw new IllegalStateException(string(result, "error", "Could not load scenario details"));
                    return result;
                });
    }

    synchronized void control(String action, String scenario) {
        JsonObject body = new JsonObject();
        body.addProperty("action", action);
        if (scenario != null && !scenario.isBlank()) body.addProperty("scenario", scenario);
        sendControl(body);
    }

    synchronized void setContinuous(boolean enabled) {
        sendToggle("continuous", enabled);
    }

    synchronized void setAutoStart(boolean enabled) {
        sendToggle("auto-start", enabled);
    }

    synchronized void startScenario() {
        if (snapshot.awaitingStartTrialId().isBlank()) return;
        JsonObject body = new JsonObject();
        body.addProperty("action", "start");
        body.addProperty("trialId", snapshot.awaitingStartTrialId());
        sendControl(body);
    }

    synchronized void setSingleScenario(boolean enabled) {
        sendToggle("single", enabled);
    }

    synchronized void selectCategory(String category) {
        JsonObject body = new JsonObject();
        body.addProperty("action", "category");
        if (category != null && !category.isBlank()) body.addProperty("category", category);
        sendControl(body);
    }

    synchronized void setJobs(int jobs) {
        JsonObject body = new JsonObject();
        body.addProperty("action", "jobs");
        body.addProperty("jobs", jobs);
        sendControl(body);
    }

    private void sendToggle(String action, boolean enabled) {
        JsonObject body = new JsonObject();
        body.addProperty("action", action);
        body.addProperty("enabled", enabled);
        sendControl(body);
    }

    private void sendControl(JsonObject body) {
        if (pendingAction != null) return;
        String action = body.get("action").getAsString();
        controlGeneration++;
        pendingAction = action;
        controlFailed = false;
        notice = action.equals("refresh") ? "Refreshing scenario files..." : "";
        HttpRequest request = request("/api/control")
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
                .build();
        client.sendAsync(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
                .thenCompose(response -> {
                    if (response.statusCode() != 202) {
                        JsonObject result = JsonParser.parseString(response.body()).getAsJsonObject();
                        throw new IllegalStateException(string(result, "error", "Request rejected"));
                    }
                    if (action.equals("refresh")) notice = "Catalog refreshed. Next run uses the latest YAML.";
                    // Read status after acceptance so an older poll cannot erase
                    // the immediate click feedback or briefly show the old run.
                    return client.sendAsync(request("/api/status")
                            .timeout(Duration.ofSeconds(2)).GET().build(),
                            HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
                })
                .whenComplete((response, error) -> {
                    synchronized (this) {
                        if (error == null) {
                            try { snapshot = parse(response.body()); lastSuccessAt = System.currentTimeMillis(); }
                            catch (RuntimeException invalid) { notice = "Could not read updated status"; controlFailed = true; }
                        } else {
                            Throwable cause = error.getCause() == null ? error : error.getCause();
                            notice = cause.getMessage() == null ? "Control request failed" : cause.getMessage();
                            controlFailed = true;
                        }
                        pendingAction = null;
                        nextPollAt = 0;
                    }
                    if (error != null) MineLabsUiMod.LOGGER.debug("Mine Labs control request failed", error);
                });
    }

    private synchronized void completePoll(HttpResponse<String> response, Throwable error, long generation) {
        requestInFlight = false;
        if (pendingAction != null || generation != controlGeneration) return;
        if (error != null || response == null || response.statusCode() != 200) {
            if (System.currentTimeMillis() - lastSuccessAt > FAILURE_GRACE_MS) {
                snapshot = Snapshot.offline("Mine Labs UI API is offline");
            }
            return;
        }
        try {
            String body = response.body();
            if (body == null || body.length() > MAX_RESPONSE_CHARS) {
                throw new IllegalArgumentException("status response was empty or too large");
            }
            snapshot = parse(body);
            lastSuccessAt = System.currentTimeMillis();
        } catch (RuntimeException parseError) {
            if (System.currentTimeMillis() - lastSuccessAt > FAILURE_GRACE_MS) {
                snapshot = Snapshot.offline("Mine Labs returned invalid status");
            }
        }
    }

    private Snapshot parse(String body) {
        JsonObject root = JsonParser.parseString(body).getAsJsonObject();
        applyClientProperties(object(root, "clientProperties"));
        List<String> scenarios = strings(root, "scenarios");
        JsonArray activeTrials = array(root, "activeTrials");
        return new Snapshot(
                true,
                integer(root, "apiVersion", 0),
                string(root, "phase", "waiting"),
                string(root, "message", "Mine Labs is ready"),
                bool(root, "continuousEnabled", true),
                bool(root, "autoStartEnabled", true),
                string(root, "awaitingStartTrialId", ""),
                bool(root, "singleScenarioEnabled", false),
                scenarios,
                parseScenarioTags(object(root, "scenarioTags")),
                parseCategories(array(root, "categories")),
                parseActive(object(root, "active"), scenarios.size()),
                parseTotals(object(root, "totals")),
                parseScenarioStats(array(root, "scenarioStats")),
                parseRecent(array(root, "recent")),
                parseConnection(object(root, "connection")),
                string(root, "currentScenario", ""),
                integer(root, "jobs", 1),
                integer(root, "maxJobs", 1),
                activeTrials == null ? 0 : activeTrials.size());
    }

    private static Map<String, List<String>> parseScenarioTags(JsonObject tags) {
        Map<String, List<String>> scenarioTags = new HashMap<>();
        if (tags != null) for (var entry : tags.entrySet()) {
            List<String> labels = new ArrayList<>();
            for (JsonElement label : entry.getValue().getAsJsonArray()) labels.add(label.getAsString());
            scenarioTags.put(entry.getKey(), List.copyOf(labels));
        }
        return Map.copyOf(scenarioTags);
    }

    private static List<Category> parseCategories(JsonArray values) {
        List<Category> categories = new ArrayList<>();
        for (JsonObject category : objects(values)) {
            categories.add(new Category(string(category, "name", "other"), strings(category, "scenarios")));
        }
        return List.copyOf(categories);
    }

    private static Active parseActive(JsonObject active, int scenarioCount) {
        if (active == null) return null;
        return new Active(
                string(active, "scenario", "scenario"),
                integer(active, "cycle", 1),
                integer(active, "scenarioIndex", 0),
                integer(active, "scenarioCount", scenarioCount),
                string(active, "startedAt", ""),
                string(active, "goalText", ""));
    }

    private static Totals parseTotals(JsonObject totals) {
        return new Totals(
                integer(totals, "runs", 0),
                integer(totals, "passed", 0),
                integer(totals, "failed", 0),
                integer(totals, "cancelled", 0));
    }

    private static List<ScenarioStats> parseScenarioStats(JsonArray values) {
        List<ScenarioStats> scenarioStats = new ArrayList<>();
        for (JsonObject stats : objects(values)) {
            // The dashboard draws the latest five outcomes.
            List<String> outcomes = strings(stats, "recentOutcomes");
            scenarioStats.add(new ScenarioStats(
                    string(stats, "scenario", "scenario"),
                    integer(stats, "runs", 0),
                    integer(stats, "passed", 0),
                    integer(stats, "failed", 0),
                    integer(stats, "cancelled", 0),
                    integer(stats, "averageElapsedMs", 0),
                    outcomes.subList(0, Math.min(5, outcomes.size()))));
        }
        return List.copyOf(scenarioStats);
    }

    private static List<Result> parseRecent(JsonArray values) {
        List<Result> recent = new ArrayList<>();
        for (JsonObject result : objects(values)) {
            if (recent.size() == 20) break;
            recent.add(new Result(
                    string(result, "scenario", "scenario"),
                    string(result, "outcome", "unknown"),
                    integer(result, "elapsedMs", 0),
                    string(result, "detail", ""),
                    string(result, "finishedAt", "")));
        }
        return List.copyOf(recent);
    }

    /**
     * The world this client should join, or null when there is none. Only a
     * world on the lab's own machine is accepted: its loopback, or the address
     * this client reached it on. Anything else rejects the whole status.
     */
    private Connection parseConnection(JsonObject value) {
        if (value == null) return null;
        Connection connection = new Connection(
                string(value, "id", ""),
                string(value, "host", ""),
                integer(value, "port", 0),
                string(value, "focusPlayer", ""));
        boolean labHost = connection.host().equals("127.0.0.1") || connection.host().equals(URI.create(baseUrl).getHost());
        if (!labHost || connection.port() < 1 || connection.port() > 65535 || connection.id().isBlank()
                || (!connection.focusPlayer().isBlank() && !connection.focusPlayer().matches(PLAYER_NAME))) {
            throw new IllegalArgumentException("invalid Mine Labs connection target");
        }
        return connection;
    }

    /**
     * A remote lab publishes the JVM properties its spectator mods read, since a
     * player's own launcher was not started with them. A property the JVM was
     * launched with still wins, and Mine Labs' own keys are never taken from the lab.
     */
    private static void applyClientProperties(JsonObject properties) {
        if (properties == null) return;
        for (var entry : properties.entrySet()) {
            String key = entry.getKey();
            if (key.startsWith("minelabs.") || !entry.getValue().isJsonPrimitive() || LAUNCH_PROPERTIES.containsKey(key)) continue;
            String value = entry.getValue().getAsString();
            if (!value.equals(System.getProperty(key))) {
                System.setProperty(key, value);
                MineLabsUiMod.LOGGER.info("Mine Labs set {}={} for the lab's spectator mods", key, value);
            }
        }
    }

    private static JsonObject object(JsonObject parent, String name) {
        if (parent == null || !parent.has(name) || !parent.get(name).isJsonObject()) return null;
        return parent.getAsJsonObject(name);
    }

    private static JsonArray array(JsonObject parent, String name) {
        if (parent == null || !parent.has(name) || !parent.get(name).isJsonArray()) return null;
        return parent.getAsJsonArray(name);
    }

    /** The array's objects; other elements are skipped. */
    private static List<JsonObject> objects(JsonArray values) {
        List<JsonObject> objects = new ArrayList<>();
        if (values != null) for (JsonElement value : values) {
            if (value.isJsonObject()) objects.add(value.getAsJsonObject());
        }
        return objects;
    }

    /** The named array's primitive values as strings; other elements are skipped. */
    private static List<String> strings(JsonObject parent, String name) {
        List<String> strings = new ArrayList<>();
        JsonArray values = array(parent, name);
        if (values != null) for (JsonElement value : values) {
            if (value.isJsonPrimitive()) strings.add(value.getAsString());
        }
        return List.copyOf(strings);
    }

    private static String string(JsonObject value, String name, String fallback) {
        try {
            return value != null && value.has(name) && !value.get(name).isJsonNull()
                    ? value.get(name).getAsString()
                    : fallback;
        } catch (RuntimeException error) {
            return fallback;
        }
    }

    private static int integer(JsonObject value, String name, int fallback) {
        try {
            return value != null && value.has(name) ? value.get(name).getAsInt() : fallback;
        } catch (RuntimeException error) {
            return fallback;
        }
    }

    private static boolean bool(JsonObject value, String name, boolean fallback) {
        try {
            return value != null && value.has(name) ? value.get(name).getAsBoolean() : fallback;
        } catch (RuntimeException error) {
            return fallback;
        }
    }

    private static String trimSlash(String value) {
        String trimmed = value.trim();
        return trimmed.endsWith("/") ? trimmed.substring(0, trimmed.length() - 1) : trimmed;
    }

    record Snapshot(
            boolean available,
            int apiVersion,
            String phase,
            String message,
            boolean continuousEnabled,
            boolean autoStartEnabled, String awaitingStartTrialId,
            boolean singleScenarioEnabled,
            List<String> scenarios, Map<String, List<String>> scenarioTags,
            List<Category> categories,
            Active active,
            Totals totals,
            List<ScenarioStats> scenarioStats,
            List<Result> recent,
            Connection connection, String currentScenario, int jobs, int maxJobs, int activeCount) {
        List<String> tagsFor(String scenario) { return scenarioTags.getOrDefault(scenario, List.of()); }

        /** Whether the lab's fields mean what this mod reads them as; an offline snapshot has none to misread. */
        boolean supported() { return !available || apiVersion == API_VERSION; }

        String versionNotice() {
            return "Mine Labs speaks UI API v" + apiVersion + " but this mod reads v" + API_VERSION + "; update the mod or the lab";
        }

        static Snapshot offline(String message) {
            return new Snapshot(false, API_VERSION, "offline", message, false, true, "", false, List.of(), Map.of(), List.of(), null, new Totals(0, 0, 0, 0), List.of(), List.of(), null, "", 1, 1, 0);
        }
    }

    record Connection(String id, String host, int port, String focusPlayer) {
        String address() { return host + ":" + port; }
    }

    record Category(String name, List<String> scenarios) {
    }

    record Active(String scenario, int cycle, int scenarioIndex, int scenarioCount, String startedAt, String goalText) {
    }

    record Totals(int runs, int passed, int failed, int cancelled) {
    }

    record ScenarioStats(
            String scenario,
            int runs,
            int passed,
            int failed,
            int cancelled,
            int averageElapsedMs,
            List<String> recentOutcomes) {
        int completed() {
            return passed + failed;
        }

        int passRate() {
            return completed() == 0 ? -1 : Math.round(100.0f * passed / completed());
        }
    }

    record Result(String scenario, String outcome, int elapsedMs, String detail, String finishedAt) {
    }
}
