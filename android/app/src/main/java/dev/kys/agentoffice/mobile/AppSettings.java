package dev.kys.agentoffice.mobile;

import android.content.Context;
import android.content.SharedPreferences;

final class AppSettings {
    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("office", Context.MODE_PRIVATE); }
    static String origin(Context c) { return prefs(c).getString("origin", ""); }
    static boolean notifications(Context c) { return prefs(c).getBoolean("notifications", false); }
    static void setNotifications(Context c, boolean on) {
        long next = Math.max(System.currentTimeMillis(), prefs(c).getLong("enabledAt", 0) + 1);
        prefs(c).edit().putBoolean("notifications", on).putLong("enabledAt", next).apply();
        c.getSharedPreferences("replies", Context.MODE_PRIVATE).edit().clear().apply();
        ReplyJobService.schedule(c);
    }
}
