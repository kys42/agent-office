package dev.kys.agentoffice.mobile;

import android.webkit.WebResourceResponse;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Bounded cache of public, content-hashed assets only. Never intercepts HTML or private APIs. */
final class AssetCache {
    private static final long BUDGET = 64L * 1024 * 1024, MAX_FILE = 4L * 1024 * 1024;
    private final File dir;
    AssetCache(File parent) { dir = new File(parent, "office-assets"); dir.mkdirs(); }

    static String hash(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder s = new StringBuilder();
            for (byte b : bytes) s.append(String.format(Locale.ROOT, "%02x", b & 255));
            return s.toString();
        } catch (Exception e) { throw new IllegalStateException(e); }
    }

    synchronized WebResourceResponse load(String origin, String url) {
        if (!ServerAddress.cacheable(origin, url)) return null;
        String ext = url.substring(url.lastIndexOf('.') + 1);
        String mime = switch (ext) { case "js" -> "text/javascript"; case "css" -> "text/css"; case "woff" -> "font/woff"; default -> "font/woff2"; };
        File file = new File(dir, hash(url));
        try {
            if (!file.exists()) {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(8000); c.setReadTimeout(10000);
                try {
                    if (c.getResponseCode() != 200) return null;
                    String type = c.getContentType();
                    if (type == null || !type.split(";")[0].trim().equals(mime)) return null;
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    try (InputStream in = c.getInputStream()) {
                        byte[] buffer = new byte[16384]; int n;
                        while ((n = in.read(buffer)) != -1) {
                            if (bytes.size() + n > MAX_FILE) return null;
                            bytes.write(buffer, 0, n);
                        }
                    }
                    File tmp = new File(dir, hash(url) + ".tmp");
                    try (FileOutputStream out = new FileOutputStream(tmp)) { bytes.writeTo(out); }
                    if (!tmp.renameTo(file)) { tmp.delete(); return null; }
                    trim();
                } finally { c.disconnect(); }
            }
            file.setLastModified(System.currentTimeMillis());
            Map<String, String> headers = new HashMap<>();
            headers.put("X-Content-Type-Options", "nosniff");
            headers.put("Cache-Control", "public, max-age=31536000, immutable");
            return new WebResourceResponse(mime, ext.startsWith("woff") ? null : "UTF-8",
                    200, "OK", headers, new FileInputStream(file));
        } catch (IOException e) { return null; }
    }

    private void trim() {
        File[] files = dir.listFiles(); if (files == null) return;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        long size = Arrays.stream(files).mapToLong(File::length).sum();
        for (File f : files) if (size > BUDGET) { long n = f.length(); if (f.delete()) size -= n; }
    }
    synchronized void clear() { File[] files = dir.listFiles(); if (files != null) for (File f : files) f.delete(); }
}
