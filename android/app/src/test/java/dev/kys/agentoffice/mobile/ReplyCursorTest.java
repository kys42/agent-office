package dev.kys.agentoffice.mobile;

import org.junit.Test;
import java.util.Set;
import static org.junit.Assert.*;

public class ReplyCursorTest {
    @Test public void onlyNewExplicitFinalsNotify() {
        ReplyCursor c = new ReplyCursor(100, Set.of());
        assertFalse(c.accept("old", 99, "final", 100));
        assertFalse(c.accept("baseline", 100, "final", 100));
        assertFalse(c.accept("progress", 101, "commentary", 100));
        assertFalse(c.accept("legacy", 101, "", 100));
        assertTrue(c.accept("a", 101, "final", 100));
        assertFalse(c.accept("a", 101, "final", 100));
        assertTrue(c.accept("b", 101, "final", 100));
        assertFalse(c.accept("late-old", 100, "final", 100));
    }
    @Test public void persistsTiesAndMovesForwardWithoutReplay() {
        ReplyCursor c = new ReplyCursor(101, Set.of("a", "b"));
        assertFalse(c.accept("a", 101, "final", 100));
        assertTrue(c.accept("c", 102, "final", 100));
        ReplyCursor restored = new ReplyCursor(c.through(), c.ids());
        assertFalse(restored.accept("c", 102, "final", 100));
        assertFalse(restored.accept("b", 101, "final", 100));
        assertTrue(restored.accept("d", 102, "final", 100));
        assertEquals(Set.of("c", "d"), restored.ids());
    }
}
