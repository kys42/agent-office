package dev.kys.agentoffice.mobile;

import android.app.*;
import android.content.*;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import java.net.URL;
import java.net.HttpURLConnection;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;

/** Run with adb reverse tcp:14322 and tcp:14323 against scripts/android-fixture.ts. */
public final class SmokeInstrumentation extends Instrumentation {
    private MainActivity activity;
    @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            Context c = getTargetContext();
            runOnMainSync(() -> {
                AppSettings.prefs(c).edit().clear().commit();
                c.getSharedPreferences("replies", Context.MODE_PRIVATE).edit().clear().commit();
                CookieManager.getInstance().removeAllCookies(null);
                WebStorage.getInstance().deleteAllData();
                c.getSystemService(NotificationManager.class).cancelAll();
            });
            activity = (MainActivity) startActivitySync(new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
            capture("setup.png");
            runOnMainSync(() -> {
                EditText address = find(activity.getWindow().getDecorView(), EditText.class);
                address.setText("http://127.0.0.1:14322");
                clickText(activity.getWindow().getDecorView(), "주소 저장하고 연결");
            });
            await("login page", "document.querySelector('input[type=password]') !== null");
            js("(()=>{let i=document.querySelector('input[type=password]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'office-android-test');i.dispatchEvent(new Event('input',{bubbles:true}));return true})()");
            Thread.sleep(250);
            js("document.querySelector('form button').click();true");
            await("agent list", "document.body.textContent.includes('Android 검수 동료')");
            await("Android filter height", "Array.from(document.querySelectorAll('.filter-row select')).every(s=>s.getBoundingClientRect().height>=44)");
            capture("office.png");
            check(AppSettings.origin(c).equals("http://127.0.0.1:14322"), "URL persisted");
            js("localStorage.setItem('android-smoke','retained');true");
            runOnMainSync(() -> { CookieManager.getInstance().flush(); find(activity.getWindow().getDecorView(), WebView.class).reload(); });
            await("login retained after reload", "document.body.textContent.includes('Android 검수 동료')");
            check("\"retained\"".equals(js("localStorage.getItem('android-smoke')")), "DOM storage retained");
            check(new java.io.File(c.getCacheDir(), "office-assets").list().length > 0, "public asset cache populated");
            runOnMainSync(() -> AppSettings.setNotifications(c, true));
            String cookie = CookieManager.getInstance().getCookie("http://127.0.0.1:14322/mobile/api/state");
            ReplyPoller.scan(c, cookie, 24);
            NotificationManager manager = c.getSystemService(NotificationManager.class);
            check(manager.getActiveNotifications().length == 0, "old final does not notify");
            Thread.sleep(50);
            HttpURLConnection control = (HttpURLConnection) new URL("http://127.0.0.1:14323/final").openConnection();
            control.setRequestMethod("POST"); check(control.getResponseCode() == 200, "synthetic final added"); control.disconnect();
            ReplyPoller.scan(c, cookie, 24);
            check(manager.getActiveNotifications().length == 1, "new final notifies");
            long first = manager.getActiveNotifications()[0].getPostTime();
            ReplyPoller.scan(c, cookie, 24);
            check(manager.getActiveNotifications()[0].getPostTime() == first, "same final not replayed");
            runOnMainSync(() -> AppSettings.setNotifications(c, false));
            check(c.getSystemService(android.app.job.JobScheduler.class).getAllPendingJobs().isEmpty(), "turning off cancels jobs");
            runOnMainSync(() -> activity.finish());
            activity = (MainActivity) startActivitySync(new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            await("activity restart retains login", "document.body.textContent.includes('Android 검수 동료')");
            check("\"retained\"".equals(js("localStorage.getItem('android-smoke')")), "restart retains DOM storage");
            runOnMainSync(() -> AppSettings.setNotifications(c, true));
            ReplyPoller.scan(c, cookie, 24);
            js("fetch('/mobile/api/logout',{method:'POST',headers:{'Content-Type':'application/json','X-Agent-Office-Mobile':'1'},body:'{}'});true");
            long end = System.currentTimeMillis() + 5000;
            while (System.currentTimeMillis() < end && !c.getSharedPreferences("replies", Context.MODE_PRIVATE).getAll().isEmpty()) Thread.sleep(50);
            check(c.getSharedPreferences("replies", Context.MODE_PRIVATE).getAll().isEmpty(), "logout clears cursors");
            check(manager.getActiveNotifications().length == 0, "logout clears notifications");
            runOnMainSync(() -> AppSettings.setNotifications(c, false));
            result.putString("stream", "PASS URL save, actual mobile login, reload cookie/DOM storage, public asset cache, old-final baseline, new-final notification, deduplication, opt-out, activity restart, logout cleanup\n");
            finish(Activity.RESULT_OK, result);
        } catch (Throwable e) {
            result.putString("stream", "FAIL " + e + "\n" + android.util.Log.getStackTraceString(e));
            finish(Activity.RESULT_CANCELED, result);
        }
    }
    private void capture(String name) throws Exception {
        Thread.sleep(500);
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(new java.io.File(getTargetContext().getExternalFilesDir(null), name))) {
            getUiAutomation().takeScreenshot().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out);
        }
    }
    private void check(boolean ok, String stage) { if (!ok) throw new AssertionError(stage); }
    private String js(String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1); AtomicReference<String> value = new AtomicReference<>();
        runOnMainSync(() -> { WebView w = find(activity.getWindow().getDecorView(), WebView.class); if (w == null) { value.set("null"); done.countDown(); } else w.evaluateJavascript(script, s -> { value.set(s); done.countDown(); }); });
        check(done.await(10, TimeUnit.SECONDS), "JS timeout"); return value.get();
    }
    private void await(String stage, String script) throws Exception {
        long end = System.currentTimeMillis() + 20000;
        while (System.currentTimeMillis() < end) { if ("true".equals(js(script))) return; Thread.sleep(150); }
        throw new AssertionError(stage + ": " + js("document.body.textContent.slice(0,1600)"));
    }
    private static void clickText(View v, String text) {
        if (v instanceof Button && text.contentEquals(((Button)v).getText())) { v.performClick(); return; }
        if (v instanceof ViewGroup) for (int i=0;i<((ViewGroup)v).getChildCount();i++) clickText(((ViewGroup)v).getChildAt(i),text);
    }
    private static <T> T find(View v, Class<T> type) {
        if (type.isInstance(v)) return type.cast(v);
        if (v instanceof ViewGroup) for (int i=0;i<((ViewGroup)v).getChildCount();i++) { T found=find(((ViewGroup)v).getChildAt(i),type); if(found!=null)return found; }
        return null;
    }
}
