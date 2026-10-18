package dev.kys.agentoffice.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.*;
import android.text.*;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import java.io.ByteArrayInputStream;
import java.util.Collections;
import java.util.concurrent.*;

public final class MainActivity extends Activity {
    private LinearLayout root;
    private FrameLayout content;
    private WebView web;
    private TextView title;
    private ProgressBar progress;
    private AssetCache assets;
    private String origin = "";
    private boolean active;
    private boolean pageFailed;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService checks = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(1), new ThreadPoolExecutor.DiscardPolicy());
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!active) return;
            if (AppSettings.notifications(MainActivity.this) && !origin.isEmpty()) {
                String cookie = CookieManager.getInstance().getCookie(origin + "/mobile/api/state");
                checks.execute(() -> ReplyPoller.scan(getApplicationContext(), cookie, 6));
            }
            handler.postDelayed(this, 15000);
        }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        assets = new AssetCache(getCacheDir());
        CookieManager.getInstance().setAcceptCookie(true);
        ReplyPoller.createChannel(this);
        origin = AppSettings.origin(this);
        buildShell();
        if (origin.isEmpty()) showSetup(); else openOffice();
        ReplyJobService.schedule(this);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private TextView text(String value, int size) {
        TextView t = new TextView(this); t.setText(value); t.setTextSize(size);
        t.setTextColor(getColor(R.color.ink)); return t;
    }
    private Button button(String value) { Button b = new Button(this); b.setText(value); b.setAllCaps(false); return b; }
    private void buildShell() {
        root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(getColor(R.color.surface));
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        LinearLayout bar = new LinearLayout(this); bar.setGravity(Gravity.CENTER_VERTICAL); bar.setPadding(dp(16), 0, dp(4), 0);
        title = text("Agent Office", 16); title.setSingleLine(); title.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        bar.addView(title, new LinearLayout.LayoutParams(0, dp(56), 1)); title.setGravity(Gravity.CENTER_VERTICAL);
        Button reload = button("↻"); reload.setContentDescription("새로고침"); reload.setMinWidth(0); reload.setMinimumWidth(0);
        bar.addView(reload, new LinearLayout.LayoutParams(dp(48), dp(48)));
        reload.setOnClickListener(v -> { if (web != null) { clearError(); web.reload(); } });
        Button menu = button("⋮"); menu.setContentDescription("앱 설정"); menu.setMinWidth(0); menu.setMinimumWidth(0);
        bar.addView(menu, new LinearLayout.LayoutParams(dp(48), dp(48))); menu.setOnClickListener(this::menu);
        root.addView(bar);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        root.addView(progress, new LinearLayout.LayoutParams(-1, dp(2))); progress.setVisibility(View.GONE);
        content = new FrameLayout(this); root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);
    }

    private void showSetup() {
        if (web != null) web.setVisibility(View.GONE);
        removeOverlay();
        ScrollView scroll = new ScrollView(this); scroll.setTag("overlay"); scroll.setFillViewport(true);
        LinearLayout panel = new LinearLayout(this); panel.setOrientation(LinearLayout.VERTICAL); panel.setPadding(dp(28), dp(32), dp(28), dp(24));
        ImageView icon = new ImageView(this); icon.setImageResource(R.drawable.office_icon); icon.setContentDescription("Agent Office 로봇");
        panel.addView(icon, new LinearLayout.LayoutParams(dp(96), dp(96)));
        TextView heading = text("내 오피스 연결", 28); heading.setPadding(0, dp(24), 0, dp(12)); panel.addView(heading);
        TextView intro = text("컴퓨터에서 켜 둔 모바일 웹 주소를 입력하세요.\n다음부터는 이 오피스를 바로 열어요.", 16); intro.setTextColor(getColor(R.color.muted)); panel.addView(intro);
        TextView label = text("서버 주소", 14); label.setPadding(0, dp(28), 0, dp(8)); panel.addView(label);
        EditText address = new EditText(this); address.setSingleLine(); address.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("http://100.x.x.x:4321"); address.setText(origin); address.setContentDescription("서버 주소");
        panel.addView(address, new LinearLayout.LayoutParams(-1, dp(56)));
        Button connect = button(origin.isEmpty() ? "주소 저장하고 연결" : "이 주소로 연결");
        connect.setBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(33, 101, 214)));
        connect.setTextColor(Color.WHITE);
        LinearLayout.LayoutParams action = new LinearLayout.LayoutParams(-1, dp(56)); action.topMargin = dp(20); panel.addView(connect, action);
        connect.setOnClickListener(v -> {
            try {
                String next = ServerAddress.normalize(address.getText().toString());
                if (!next.equals(origin) && !origin.isEmpty()) {
                    new AlertDialog.Builder(this).setTitle("연결할 오피스를 바꿀까요?")
                            .setMessage("이 앱의 이전 로그인과 웹 저장소를 지우고 새 주소에 연결해요.")
                            .setNegativeButton("취소", null).setPositiveButton("주소 변경", (d, w) -> changeServer(next)).show();
                } else if (next.equals(origin)) { removeOverlay(); if (web != null) web.setVisibility(View.VISIBLE); else openOffice(); }
                else changeServer(next);
            } catch (IllegalArgumentException e) { address.setError(e.getMessage()); }
        });
        TextView help = text("Tailscale을 켜고 컴퓨터와 같은 네트워크에 연결해 주세요. 접속 코드는 다음 로그인 화면에서 입력해요.\n\n로그인 세션과 웹 저장소를 유지하며, 화면 파일을 캐시해 다시 열 때의 다운로드를 줄여요. 대화는 서버에 연결해 최신 상태로 읽어요.", 14);
        help.setTextColor(getColor(R.color.muted)); help.setPadding(0, dp(24), 0, 0); panel.addView(help);
        scroll.addView(panel); content.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
        title.setText("Agent Office");
    }

    private void changeServer(String next) {
        AppSettings.setNotifications(this, false);
        getSystemService(NotificationManager.class).cancelAll();
        if (web != null) { content.removeView(web); web.destroy(); web = null; }
        WebStorage.getInstance().deleteAllData(); assets.clear();
        CookieManager.getInstance().removeAllCookies(done -> {
            CookieManager.getInstance().flush();
            origin = next; AppSettings.prefs(this).edit().putString("origin", next).putBoolean("loginNeeded", false).apply();
            if (next.isEmpty()) showSetup(); else openOffice();
        });
    }

    @SuppressLint("SetJavaScriptEnabled") // The trusted user-selected web app requires JS. There is no native JS bridge.
    private void openOffice() {
        removeOverlay();
        title.setText(origin.replaceFirst("^https?://", ""));
        if (web != null) { web.setVisibility(View.VISIBLE); return; }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web = new WebView(this); web.setId(android.R.id.content);
        WebSettings settings = web.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT); settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setGeolocationEnabled(false); settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true); settings.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int value) {
                progress.setProgress(value); progress.setVisibility(value < 100 ? View.VISIBLE : View.GONE);
            }
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (ServerAddress.sameOrigin(origin, url)) return false;
                if (request.isForMainFrame() && request.hasGesture() && (url.startsWith("https://") || url.startsWith("http://"))) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (ActivityNotFoundException ignored) { }
                }
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (!ServerAddress.sameOrigin(origin, url)) return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
                if (url.equals(origin + "/mobile/api/logout")) {
                    long next = Math.max(System.currentTimeMillis(), AppSettings.prefs(MainActivity.this).getLong("enabledAt", 0) + 1);
                    AppSettings.prefs(MainActivity.this).edit().putLong("enabledAt", next).apply();
                    getSharedPreferences("replies", MODE_PRIVATE).edit().clear().apply();
                    getSystemService(NotificationManager.class).cancelAll();
                }
                return "GET".equals(request.getMethod()) ? assets.load(origin, url) : null;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                if (!ServerAddress.sameOrigin(origin, url)) { view.stopLoading(); showError(); return; }
                pageFailed = false;
            }
            @Override public void onPageFinished(WebView view, String url) {
                // Android WebView's native select metrics can clip the mobile web's padded filters.
                if (ServerAddress.sameOrigin(origin, url)) view.evaluateJavascript(
                        "(()=>{if(window.__officeAndroidFilters)return;const fit=()=>document.querySelectorAll('.filter-row select').forEach(s=>{s.style.minHeight='44px';s.style.height='44px';s.style.lineHeight='normal';s.style.paddingTop='0';s.style.paddingBottom='0'});fit();window.__officeAndroidFilters=new MutationObserver(fit);window.__officeAndroidFilters.observe(document.body,{childList:true,subtree:true})})()", null);
                CookieManager.getInstance().flush();
                if (!pageFailed && ServerAddress.sameOrigin(origin, url)) clearError();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) { if (req.isForMainFrame()) showError(); }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest req, WebResourceResponse error) { if (req.isForMainFrame()) showError(); }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler h, SslError e) { h.cancel(); showError(); }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                content.removeView(view); view.destroy(); web = null; showError(); return true;
            }
        });
        content.addView(web, 0, new FrameLayout.LayoutParams(-1, -1));
        web.loadUrl(origin + "/");
    }

    private void showError() {
        pageFailed = true; progress.setVisibility(View.GONE); removeOverlay();
        LinearLayout panel = new LinearLayout(this); panel.setTag("overlay"); panel.setOrientation(LinearLayout.VERTICAL); panel.setGravity(Gravity.CENTER); panel.setPadding(dp(28), dp(24), dp(28), dp(24)); panel.setBackgroundColor(getColor(R.color.surface));
        panel.addView(text("오피스에 연결하지 못했어요", 22));
        TextView detail = text("Tailscale과 컴퓨터의 오피스 앱이 켜져 있는지 확인해 주세요. 저장한 주소와 로그인은 유지돼요.", 16); detail.setPadding(0, dp(20), 0, dp(20)); panel.addView(detail);
        Button retry = button("다시 연결"); panel.addView(retry); retry.setOnClickListener(v -> { clearError(); if (web == null) openOffice(); else web.loadUrl(origin + "/"); });
        Button edit = button("서버 주소 확인"); panel.addView(edit); edit.setOnClickListener(v -> showSetup());
        content.addView(panel, new FrameLayout.LayoutParams(-1, -1));
    }
    private void clearError() { pageFailed = false; removeOverlay(); }
    private void removeOverlay() { View overlay = content.findViewWithTag("overlay"); if (overlay != null) content.removeView(overlay); }

    private void menu(View anchor) {
        PopupMenu menu = new PopupMenu(this, anchor);
        menu.getMenu().add("서버 주소").setOnMenuItemClickListener(item -> { showSetup(); return true; });
        menu.getMenu().add(AppSettings.notifications(this) ? "최종응답 알림 끄기" : "최종응답 알림 켜기").setOnMenuItemClickListener(item -> { notifications(); return true; });
        menu.getMenu().add("로컬 데이터 지우기").setOnMenuItemClickListener(item -> {
            new AlertDialog.Builder(this).setTitle("이 기기의 데이터를 지울까요?").setMessage("주소·로그인·웹 저장소·캐시와 알림 기록을 지워요. 서버의 대화는 그대로 남아요.")
                    .setNegativeButton("취소", null).setPositiveButton("지우기", (d, w) -> { changeServer(""); }).show(); return true;
        });
        menu.show();
    }
    private void notifications() {
        if (AppSettings.notifications(this)) { AppSettings.setNotifications(this, false); getSystemService(NotificationManager.class).cancelAll(); toast("최종응답 알림을 껐어요."); return; }
        if (origin.isEmpty()) { toast("먼저 오피스 주소를 연결해 주세요."); return; }
        new AlertDialog.Builder(this).setTitle("새 최종응답 알림")
                .setMessage("로그인한 오피스의 새로운 최종응답을 확인해 알려요. 앱을 보는 동안 자주 확인하고, 백그라운드에서는 15분 이상의 간격으로 나눠 확인해요. 절전·네트워크·대화 수에 따라 늦어질 수 있어요. 세션이 만료되면 앱에서 다시 로그인해 주세요.")
                .setNegativeButton("나중에", null).setPositiveButton("알림 켜기", (d, w) -> {
                    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
                    else enableNotifications();
                }).show();
    }
    private void enableNotifications() {
        if (!ReplyPoller.permitted(this)) { toast("Android 설정에서 Agent Office 알림을 허용해 주세요."); return; }
        AppSettings.setNotifications(this, true); handler.removeCallbacks(tick); handler.post(tick); toast("지금부터 새 최종응답을 확인해요.");
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == 1 && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) enableNotifications();
    }
    private void toast(String text) { Toast.makeText(this, text, Toast.LENGTH_LONG).show(); }
    @Override protected void onResume() { super.onResume(); active = true; if (web != null) web.onResume(); handler.removeCallbacks(tick); handler.post(tick); }
    @Override protected void onPause() { active = false; handler.removeCallbacks(tick); CookieManager.getInstance().flush(); if (web != null) web.onPause(); super.onPause(); }
    @Override protected void onDestroy() { handler.removeCallbacks(tick); checks.shutdownNow(); if (web != null) { content.removeView(web); web.destroy(); } super.onDestroy(); }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); if (origin.equals(intent.getStringExtra("officeOrigin"))) { removeOverlay(); openOffice(); } }
    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() {
        if (content.findViewWithTag("overlay") != null && web != null && !pageFailed) { removeOverlay(); web.setVisibility(View.VISIBLE); return; }
        if (web != null) {
            web.evaluateJavascript("(()=>{const b=document.querySelector('.chat-header > button');if(b){b.click();return true}return false})()", handled -> {
                if (!"true".equals(handled)) {
                    if (web != null && web.canGoBack()) web.goBack(); else MainActivity.super.onBackPressed();
                }
            });
        } else super.onBackPressed();
    }
}
