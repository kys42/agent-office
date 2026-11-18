package dev.kys.agentoffice.mobile;

import java.util.LinkedHashSet;
import java.util.Set;

/** Persist IDs only. A first snapshot is a silent baseline; older replies never become new. */
public final class ReplyCursor {
    private long through;
    private final Set<String> ids;
    public ReplyCursor(long through, Set<String> ids) {
        this.through = through;
        this.ids = new LinkedHashSet<>(ids);
    }
    public boolean accept(String id, long at, String phase, long enabledAt) {
        if (!"final".equals(phase) || id == null || id.isEmpty() || at <= enabledAt || at < through || ids.contains(id)) return false;
        if (at > through) { through = at; ids.clear(); }
        ids.add(id);
        return true;
    }
    public long through() { return through; }
    public Set<String> ids() { return new LinkedHashSet<>(ids); }
}
