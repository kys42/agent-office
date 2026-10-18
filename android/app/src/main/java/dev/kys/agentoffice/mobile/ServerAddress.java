package dev.kys.agentoffice.mobile;

import java.net.URI;
import java.util.Locale;

/** Only a server origin is saved. Codes, paths, credentials and redirects are never accepted. */
public final class ServerAddress {
    private ServerAddress() {}

    public static String normalize(String input) {
        try {
            URI u = new URI(input.trim());
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
            String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
            String path = u.getRawPath();
            if ((!scheme.equals("http") && !scheme.equals("https")) || host.isEmpty()
                    || u.getRawUserInfo() != null || u.getRawQuery() != null || u.getRawFragment() != null
                    || (path != null && !path.isEmpty() && !path.equals("/") && !path.equals("/mobile.html"))
                    || u.getPort() == 0 || u.getPort() > 65535 || u.getPort() < -1)
                throw new IllegalArgumentException();
            if (scheme.equals("http") && !host.equals("127.0.0.1") && !isTailnet(host))
                throw new IllegalArgumentException();
            return scheme + "://" + host + (u.getPort() == -1 ? "" : ":" + u.getPort());
        } catch (Exception e) {
            throw new IllegalArgumentException("Tailscale HTTP 주소 또는 HTTPS 서버 주소를 입력해 주세요. 경로·접속 코드는 넣지 않아요.");
        }
    }

    private static boolean isTailnet(String host) {
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        int[] n = new int[4];
        for (int i = 0; i < 4; i++) {
            if (!parts[i].matches("0|[1-9][0-9]{0,2}")) return false;
            n[i] = Integer.parseInt(parts[i]);
            if (n[i] > 255) return false;
        }
        return n[0] == 100 && n[1] >= 64 && n[1] <= 127;
    }

    public static boolean sameOrigin(String origin, String candidate) {
        try {
            URI u = new URI(candidate);
            if (u.getRawUserInfo() != null) return false;
            URI a = new URI(origin);
            return a.getScheme().equalsIgnoreCase(u.getScheme()) && a.getHost().equalsIgnoreCase(u.getHost())
                    && port(a) == port(u);
        } catch (Exception e) { return false; }
    }

    private static int port(URI u) { return u.getPort() != -1 ? u.getPort() : "https".equalsIgnoreCase(u.getScheme()) ? 443 : 80; }

    public static boolean cacheable(String origin, String candidate) {
        if (!sameOrigin(origin, candidate)) return false;
        try {
            URI u = new URI(candidate);
            return u.getRawQuery() == null && u.getRawFragment() == null
                    && u.getRawPath().matches("/assets/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\\.(js|css|woff2?)");
        } catch (Exception e) { return false; }
    }
}
