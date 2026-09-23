package dev.minelabs.ui;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.URLEncoder;
import java.util.concurrent.CompletableFuture;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.HashMap;

final class LabApiClient {
    private static final String DEFAULT_URL = "http://127.0.0.1:25578";
    private static final long POLL_INTERVAL_MS = 500;
    private static final long FAILURE_GRACE_MS = 2_000;
    private static final int MAX_RESPONSE_CHARS = 1_000_000;

    private final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(1))
            .build();
    private final String baseUrl = trimSlash(System.getProperty("minelabs.uiUrl", DEFAULT_URL));
    private volatile Snapshot snapshot = Snapshot.offline("waiting for Mine Labs");
    private boolean requestInFlight;
    private long nextPollAt;
    private long lastSuccessAt;
    private volatile String pendingAction;
    private volatile String notice = "";
    private volatile boolean controlFailed;
    private long controlGeneration;

    String pendingAction() { return pendingAction; }
    String notice() { return notice; }
    boolean controlFailed() { return controlFailed; }

    synchronized void tick() {
        long now = System.currentTimeMillis();
        if (requestInFlight || pendingAction != null || now < nextPollAt) return;
        requestInFlight = true;
        nextPollAt = now + POLL_INTERVAL_MS;
        HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + "/api/status"))
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
        return client.sendAsync(HttpRequest.newBuilder(URI.create(baseUrl + "/api/scenario?" + query))
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
        JsonObject body = new JsonObject();
        body.addProperty("action", "continuous");
        body.addProperty("enabled", enabled);
        sendControl(body);
    }

    synchronized void setAutoStart(boolean enabled) {
        JsonObject body = new JsonObject();
        body.addProperty("action", "auto-start");
        body.addProperty("enabled", enabled);
        sendControl(body);
    }

    synchronized void startScenario() {
        if (snapshot.awaitingStartTrialId().isBlank()) return;
        JsonObject body = new JsonObject();
        body.addProperty("action", "start");
        body.addProperty("trialId", snapshot.awaitingStartTrialId());
        sendControl(body);
    }

    synchronized void setSingleScenario(boolean enabled) {
        JsonObject body = new JsonObject();
        body.addProperty("action", "single");
        body.addProperty("enabled", enabled);
        sendControl(body);
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

    private void sendControl(JsonObject body) {
        if (pendingAction != null) return;
        controlGeneration++;
        pendingAction = body.get("action").getAsString();
        controlFailed = false;
        notice = pendingAction.equals("refresh") ? "Refreshing scenario files..." : "";
        HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + "/api/control"))
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
                    if (body.get("action").getAsString().equals("refresh")) notice = "Catalog refreshed. Next run uses the latest YAML.";
                    // Read status after acceptance so an older poll cannot erase
                    // the immediate click feedback or briefly show the old run.
                    return client.sendAsync(HttpRequest.newBuilder(URI.create(baseUrl + "/api/status"))
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

    private static Snapshot parse(String body) {
        JsonObject root = JsonParser.parseString(body).getAsJsonObject();
        List<String> scenarios = new ArrayList<>();
        JsonArray scenarioValues = array(root, "scenarios");
        if (scenarioValues != null) {
            for (JsonElement value : scenarioValues) {
                if (value.isJsonPrimitive()) scenarios.add(value.getAsString());
            }
        }
        Map<String, List<String>> scenarioTags = new HashMap<>();
        JsonObject tags = object(root, "scenarioTags");
        if (tags != null) for (var entry : tags.entrySet()) {
            List<String> labels = new ArrayList<>();
            for (JsonElement label : entry.getValue().getAsJsonArray()) labels.add(label.getAsString());
            scenarioTags.put(entry.getKey(), List.copyOf(labels));
        }
        List<Category> categories = new ArrayList<>();
        JsonArray categoryValues = array(root, "categories");
        if (categoryValues != null) {
            for (JsonElement value : categoryValues) {
                if (!value.isJsonObject()) continue;
                JsonObject category = value.getAsJsonObject();
                List<String> names = new ArrayList<>();
                JsonArray nameValues = array(category, "scenarios");
                if (nameValues != null) {
                    for (JsonElement name : nameValues) {
                        if (name.isJsonPrimitive()) names.add(name.getAsString());
                    }
                }
                categories.add(new Category(string(category, "name", "other"), List.copyOf(names)));
            }
        }
        Active active = null;
        JsonObject activeValue = object(root, "active");
        if (activeValue != null) {
            active = new Active(
                    string(activeValue, "scenario", "scenario"),
                    integer(activeValue, "cycle", 1),
                    integer(activeValue, "scenarioIndex", 0),
                    integer(activeValue, "scenarioCount", scenarios.size()),
                    string(activeValue, "startedAt", ""),
                    string(activeValue, "goalText", ""));
        }
        JsonObject totalsValue = object(root, "totals");
        Totals totals = new Totals(
                integer(totalsValue, "runs", 0),
                integer(totalsValue, "passed", 0),
                integer(totalsValue, "failed", 0),
                integer(totalsValue, "cancelled", 0));
        List<ScenarioStats> scenarioStats = new ArrayList<>();
        JsonArray scenarioStatValues = array(root, "scenarioStats");
        if (scenarioStatValues != null) {
            for (JsonElement value : scenarioStatValues) {
                if (!value.isJsonObject()) continue;
                JsonObject stats = value.getAsJsonObject();
                List<String> recentOutcomes = new ArrayList<>();
                JsonArray outcomes = array(stats, "recentOutcomes");
                if (outcomes != null) {
                    for (JsonElement outcome : outcomes) {
                        if (outcome.isJsonPrimitive() && recentOutcomes.size() < 5) {
                            recentOutcomes.add(outcome.getAsString());
                        }
                    }
                }
                scenarioStats.add(new ScenarioStats(
                        string(stats, "scenario", "scenario"),
                        integer(stats, "runs", 0),
                        integer(stats, "passed", 0),
                        integer(stats, "failed", 0),
                        integer(stats, "cancelled", 0),
                        integer(stats, "averageElapsedMs", 0),
                        List.copyOf(recentOutcomes)));
            }
        }
        List<Result> recent = new ArrayList<>();
        JsonArray recentValues = array(root, "recent");
        if (recentValues != null) {
            for (JsonElement value : recentValues) {
                if (!value.isJsonObject() || recent.size() == 20) continue;
                JsonObject result = value.getAsJsonObject();
                recent.add(new Result(
                        string(result, "scenario", "scenario"),
                        string(result, "outcome", "unknown"),
                        integer(result, "elapsedMs", 0),
                        string(result, "detail", ""),
                        string(result, "finishedAt", "")));
            }
        }
        JsonObject connectionValue = object(root, "connection");
        Connection connection = connectionValue == null ? null : new Connection(
                string(connectionValue, "id", ""),
                string(connectionValue, "host", ""), integer(connectionValue, "port", 0), string(connectionValue, "focusPlayer", ""));
        if (connection != null && (!connection.host().equals("127.0.0.1")
                || connection.port() < 1 || connection.port() > 65535 || connection.id().isBlank()
                || (!connection.focusPlayer().isBlank() && !connection.focusPlayer().matches("[A-Za-z0-9_]{1,16}")))) {
            throw new IllegalArgumentException("invalid Mine Labs connection target");
        }
        return new Snapshot(
                true,
                string(root, "phase", "waiting"),
                string(root, "message", "Mine Labs is ready"),
                bool(root, "continuousEnabled", true),
                bool(root, "autoStartEnabled", true), string(root, "awaitingStartTrialId", ""),
                bool(root, "singleScenarioEnabled", false),
                string(root, "selectedCategory", null),
                List.copyOf(scenarios), Map.copyOf(scenarioTags),
                List.copyOf(categories),
                active,
                totals,
                List.copyOf(scenarioStats),
                List.copyOf(recent), connection, string(root, "currentScenario", ""), integer(root, "jobs", 1), integer(root, "maxJobs", 1), array(root, "activeTrials") == null ? 0 : array(root, "activeTrials").size());
    }

    private static JsonObject object(JsonObject parent, String name) {
        if (parent == null || !parent.has(name) || !parent.get(name).isJsonObject()) return null;
        return parent.getAsJsonObject(name);
    }

    private static JsonArray array(JsonObject parent, String name) {
        if (parent == null || !parent.has(name) || !parent.get(name).isJsonArray()) return null;
        return parent.getAsJsonArray(name);
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
            String phase,
            String message,
            boolean continuousEnabled,
            boolean autoStartEnabled, String awaitingStartTrialId,
            boolean singleScenarioEnabled,
            String selectedCategory,
            List<String> scenarios, Map<String, List<String>> scenarioTags,
            List<Category> categories,
            Active active,
            Totals totals,
            List<ScenarioStats> scenarioStats,
            List<Result> recent,
            Connection connection, String currentScenario, int jobs, int maxJobs, int activeCount) {
        List<String> tagsFor(String scenario) { return scenarioTags.getOrDefault(scenario, List.of()); }

        static Snapshot offline(String message) {
            return new Snapshot(false, "offline", message, false, true, "", false, null, List.of(), Map.of(), List.of(), null, new Totals(0, 0, 0, 0), List.of(), List.of(), null, "", 1, 1, 0);
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
