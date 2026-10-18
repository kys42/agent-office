package dev.kys.agentoffice.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class ServerAddressTest {
    @Test public void savesOnlyAnOrigin() {
        assertEquals("http://100.93.102.28:4321", ServerAddress.normalize(" http://100.93.102.28:4321/mobile.html "));
        assertEquals("https://office.example.com", ServerAddress.normalize("HTTPS://Office.Example.COM/"));
        assertEquals("http://127.0.0.1:4321", ServerAddress.normalize("http://127.0.0.1:4321"));
    }
    @Test public void rejectsCredentialsPublicCleartextAndEncodedPaths() {
        for (String url : new String[]{"javascript:alert(1)", "file:///sdcard/a", "http://example.com", "http://192.168.0.2:4321", "http://100.63.0.1:4321", "http://100.128.0.1:4321", "http://100.64.0.999:4321", "http://100.064.0.1:4321", "http://100.64.0.1:0", "https://user:password@example.com", "https://example.com/?code=secret", "https://example.com/#secret", "https://example.com/%2f", "https://example.com/mobile/api/login", "https://example.com:99999"}) {
            assertThrows(url, IllegalArgumentException.class, () -> ServerAddress.normalize(url));
        }
    }
    @Test public void checksOriginsExactly() {
        assertTrue(ServerAddress.sameOrigin("https://office.example.com", "https://office.example.com:443/mobile.html#chat"));
        for (String url : new String[]{"http://office.example.com", "https://office.example.com.evil.test", "https://office.example.com@evil.test", "https://office.example.com:444/", "data:text/html,hello"})
            assertFalse(url, ServerAddress.sameOrigin("https://office.example.com", url));
    }
    @Test public void cachesOnlySameOriginHashedPublicAssets() {
        String origin = "http://100.64.0.1:4321";
        assertTrue(ServerAddress.cacheable(origin, origin + "/assets/mobile-Cb52LfNq.js"));
        assertTrue(ServerAddress.cacheable(origin, origin + "/assets/PretendardVariable-subset-52-CNgqKOOJ.woff2"));
        for (String path : new String[]{"/", "/mobile.html", "/mobile/api/state", "/assets/chat.json", "/assets/app.js", "/assets/app-12345678.js?token=secret", "/assets/../mobile/api/state", "/assets/a%2fb-12345678.js"})
            assertFalse(path, ServerAddress.cacheable(origin, origin + path));
        assertFalse(ServerAddress.cacheable(origin, "https://evil.test/assets/app-12345678.js"));
    }
}
