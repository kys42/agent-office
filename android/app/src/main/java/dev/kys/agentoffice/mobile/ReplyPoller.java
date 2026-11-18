package dev.kys.agentoffice.mobile;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.Build;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

final class ReplyPoller {
    private static final AtomicBoolean running = new AtomicBoolean();
    static final String CHANNEL = "final-replies";

    static boolean permitted(Context c) {
        return (Build.VERSION.SDK_INT < 33 || c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
                && c.getSystemService(NotificationManager.class).areNotificationsEnabled();
    }

    static void createChannel(Context c) {
        NotificationChannel channel = new NotificationChannel(CHANNEL, "새 최종응답", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("연결된 오피스에서 새로 도착한 최종응답을 알려요.");
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        c.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    static void scan(Context c, String cookie, int limit) {
        if (!AppSettings.notifications(c) || !permitted(c) || cookie == null || !cookie.contains("ao_mobile=") || !running.compareAndSet(false, true)) return;
        String origin = AppSettings.origin(c);
        long generation = AppSettings.prefs(c).getLong("enabledAt", 0);
        try {
            ServerAddress.normalize(origin);
            SharedPreferences store = c.getSharedPreferences("replies", Context.MODE_PRIVATE);
            JSONObject state = post(origin, "state", new JSONObject(), cookie);
            if (!current(c, origin, generation)) return;
            if (state.optBoolean("privacy")) {
                c.getSystemService(NotificationManager.class).cancelAll();
                store.edit().clear().commit();
                return;
            }
            String auth = AssetCache.hash(origin + "\n" + cookie);
            if (!auth.equals(store.getString("auth", ""))) {
                // A new login or opt-in sets a server-clock baseline; no backlog burst.
                store.edit().clear().putString("auth", auth).putLong("baseline", state.getLong("at")).commit();
            }
            long baseline = store.getLong("baseline", state.getLong("at"));
            JSONObject saved = new JSONObject(store.getString("cursors", "{}"));
            JSONArray agents = state.getJSONArray("agents");
            ArrayList<JSONObject> eligible = new ArrayList<>();
            Set<String> visible = new HashSet<>();
            for (int i = 0; i < agents.length(); i++) {
                JSONObject a = agents.getJSONObject(i);
                visible.add(a.getString("id"));
                if (!a.optBoolean("archived") && !a.optBoolean("stale")) eligible.add(a);
            }
            ArrayList<String> remove = new ArrayList<>();
            saved.keys().forEachRemaining(k -> { if (!visible.contains(k)) remove.add(k); });
            for (String k : remove) saved.remove(k);
            eligible.sort(Comparator.comparingLong(a -> {
                JSONObject row = saved.optJSONObject(a.optString("id"));
                return row == null ? 0 : row.optLong("checked");
            }));
            long deadline = System.currentTimeMillis() + 40000;
            int n = 0;
            for (JSONObject a : eligible) {
                if (n++ >= limit || System.currentTimeMillis() > deadline || Thread.currentThread().isInterrupted() || !current(c, origin, generation)) break;
                String id = a.getString("id");
                JSONObject detail;
                try { detail = post(origin, "detail", new JSONObject().put("id", id), cookie); }
                catch (Denied denied) { if (denied.status == 401) throw denied; else continue; }
                JSONObject row = saved.optJSONObject(id);
                if (row == null) row = new JSONObject();
                Set<String> ids = new LinkedHashSet<>();
                JSONArray seen = row.optJSONArray("ids");
                if (seen != null) for (int j = 0; j < seen.length(); j++) ids.add(seen.getString(j));
                ReplyCursor cursor = new ReplyCursor(row.optLong("through", baseline), ids);
                JSONArray events = detail.getJSONArray("events");
                ArrayList<JSONObject> sorted = new ArrayList<>();
                for (int j = 0; j < events.length(); j++) sorted.add(events.getJSONObject(j));
                sorted.sort(Comparator.comparingLong(e -> e.optLong("at")));
                boolean found = false;
                for (JSONObject e : sorted) {
                    if ("assistant".equals(e.optString("kind")))
                        found |= cursor.accept(e.optString("id"), e.optLong("at"), e.optString("phase"), baseline);
                }
                saved.put(id, new JSONObject().put("through", cursor.through()).put("ids", new JSONArray(cursor.ids())).put("checked", System.currentTimeMillis()));
                if (!current(c, origin, generation)) return;
                // Persist before notification so a process restart cannot replay the same response.
                if (!store.edit().putString("cursors", saved.toString()).commit()) return;
                if (found && current(c, origin, generation)) notifyReply(c, origin, id);
            }
        } catch (Denied e) {
            if (e.status == 401 && current(c, origin, generation))
                AppSettings.prefs(c).edit().putBoolean("loginNeeded", true).apply();
        } catch (Exception ignored) {
            // Offline, expired login or a stopped server: the next scheduled check retries reads only.
        } finally { running.set(false); }
    }

    private static boolean current(Context c, String origin, long generation) {
        return AppSettings.notifications(c) && origin.equals(AppSettings.origin(c))
                && generation == AppSettings.prefs(c).getLong("enabledAt", 0) && permitted(c);
    }

    private static JSONObject post(String origin, String route, JSONObject body, String cookie) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(origin + "/mobile/api/" + route).openConnection();
        conn.setInstanceFollowRedirects(false); conn.setRequestMethod("POST"); conn.setDoOutput(true);
        conn.setConnectTimeout(5000); conn.setReadTimeout(8000);
        conn.setRequestProperty("Content-Type", "application/json"); conn.setRequestProperty("Origin", origin);
        conn.setRequestProperty("X-Agent-Office-Mobile", "1"); conn.setRequestProperty("Cookie", cookie);
        try {
            try (OutputStream out = conn.getOutputStream()) { out.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            int status = conn.getResponseCode(); if (status != 200) throw new Denied(status);
            try (InputStream in = conn.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[16384]; int n;
                while ((n = in.read(buf)) != -1) {
                    if (out.size() + n > 4 * 1024 * 1024) throw new IOException("Response too large");
                    out.write(buf, 0, n);
                }
                return new JSONObject(out.toString(StandardCharsets.UTF_8.name()));
            }
        } finally { conn.disconnect(); }
    }

    private static void notifyReply(Context c, String origin, String id) {
        if (!permitted(c)) return;
        createChannel(c);
        int key = (origin + "\n" + id).hashCode();
        Intent intent = new Intent(c, MainActivity.class).putExtra("officeOrigin", origin)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(c, key, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(c, CHANNEL).setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Agent Office").setContentText("새 최종응답이 도착했어요. 오피스를 열어 확인하세요.")
                .setContentIntent(pending).setAutoCancel(true).setVisibility(Notification.VISIBILITY_PRIVATE).build();
        c.getSystemService(NotificationManager.class).notify(key, notification);
    }

    private static final class Denied extends IOException {
        final int status;
        Denied(int status) { this.status = status; }
    }
}
