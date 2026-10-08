import type { Session, Snapshot, Mood, Provider } from '../shared/types';
import { localizeNotice, noticeCandidates } from '../shared/notices';
import { runtimeObservation } from '../shared/presentation';
import { deriveState } from '../shared/runtime';
import { officeResidents } from '../shared/residents';
import { allocateSeats, officeZone, attachSessions, seatKey } from '../shared/office';
import { applyZone } from '../shared/zones';
import { m } from '../shared/i18n';
export function reconcileDemo(snapshot: Snapshot): Snapshot {
  const sessions = snapshot.sessions.map((s) => ({
    ...applyZone(s, snapshot.preferences.zoneRules),
    zone: officeZone(s, snapshot.preferences),
  }));
  const active = officeResidents(sessions).sessions.filter((s) => s.zone === 'office');
  const previous = Object.fromEntries(
    active.filter((s) => s.officeSeat !== undefined).map((s) => [seatKey(s), s.officeSeat!]),
  );
  const seats = allocateSeats(active, previous);
  return {
    ...snapshot,
    sessions: attachSessions(sessions.map((s) => ({ ...s, officeSeat: seats[seatKey(s)] }))),
  };
}
/**
 * The demo as the service would serve it at `now`: the same status ladder over each session's
 * own (observed) status and the same zone rule, so labels move with the poses (work → standing
 * by after 2 minutes…) and long-quiet desks leave for the lounge. The held demo keeps the
 * observed statuses; only what is shown is derived, like `decorate`. With `memo`, a session
 * whose derived look did not change keeps its object.
 */
export function deriveDemo(
  snapshot: Snapshot,
  now = Date.now(),
  memo?: WeakMap<Session, Session>,
): Snapshot {
  const prefs = snapshot.preferences;
  let changed = false;
  const sessions = snapshot.sessions.map((s) => {
    const state = deriveState(
      s.status,
      s.updatedAt,
      now,
      s.archived,
      prefs.standbyHours,
      prefs.readyMinutes,
    );
    const zone = officeZone(s, prefs, now);
    if (!state.reason && zone === s.zone) return s;
    changed = true;
    const prior = memo?.get(s);
    if (
      prior &&
      prior.status === state.status &&
      prior.statusReason === (state.reason ?? s.statusReason) &&
      prior.zone === zone
    )
      return prior;
    const next: Session = state.reason
      ? {
          ...s,
          observedStatus: s.status,
          status: state.status,
          statusReason: state.reason,
          statusEvidence: 'derived',
          zone,
        }
      : { ...s, zone };
    memo?.set(s, next);
    return next;
  });
  return changed ? { ...snapshot, sessions } : snapshot;
}
/**
 * `deriveDemo` on a clock: while the held demo and every derived session stay the same, the
 * previous result comes back, so effects keyed on the snapshot or its sessions stay quiet.
 */
export function demoDeriver() {
  const memo = new WeakMap<Session, Session>();
  let last: { from: Snapshot; shown: Snapshot } | undefined;
  return (snapshot: Snapshot, now = Date.now()) => {
    const shown = deriveDemo(snapshot, now, memo);
    if (
      last?.from === snapshot &&
      shown.sessions.length === last.shown.sessions.length &&
      shown.sessions.every((s, i) => s === last!.shown.sessions[i])
    )
      return last.shown;
    last = { from: snapshot, shown };
    return shown;
  };
}
// Desk order, provider, project and status; names and text come from the active language.
const defs: [Provider, string, Mood][] = [
  ['claude', 'agent-office', 'work'],
  ['codex', 'agent-office', 'think'],
  ['openclaw', 'daily-brief', 'work'],
  ['claude', 'my-notes', 'call'],
  ['codex', 'api-server', 'work'],
  ['claude', 'design-system', 'done'],
  ['codex', 'web-app', 'sleep'],
  ['openclaw', 'assistant', 'idle'],
];
/** A sample office in the active language. */
export function demoSnapshot(): Snapshot {
  const now = Date.now();
  const t = m().demo;
  const snapshot: Snapshot = {
    version: 1,
    syncing: false,
    error: null,
    lastSync: now,
    preferences: {
      paused: false,
      privacy: false,
      reducedMotion: false,
      excludedProjects: [],
      enabledProviders: ['claude', 'codex', 'openclaw'],
      maxSessions: 120,
      standbyHours: 4,
      archiveDays: 7,
      bubbleHours: 3,
    },
    connectors: (['claude', 'codex', 'openclaw'] as Provider[]).map((provider) => ({
      provider,
      state: 'connected',
      path: t.connectorPath,
      count: defs.filter((d) => d[0] === provider).length,
      lastSync: now,
      message: t.connectorMessage,
    })),
    sessions: defs.map(([provider, project, status], i) => {
      const { alias, title, action } = t.sessions[i];
      return {
        id: `demo:${i}`,
        nativeId: `demo-${i}`,
        protocolVersion: 1,
        runtime: runtimeObservation(status, now - i * 10_000, t.runtimeReason),
        relation: { kind: 'root', parentNativeId: null, source: 'demo' },
        provider,
        title,
        alias,
        project,
        status,
        action,
        cwd: `~/Projects/${project}`,
        branch: 'feat/tiny-office',
        model:
          provider === 'claude'
            ? 'Claude Opus'
            : provider === 'codex'
              ? 'GPT Codex'
              : 'OpenClaw Agent',
        startedAt: now - 60 * 60_000,
        updatedAt: i === 6 ? now - 5 * 3600_000 : i === 7 ? now - 9 * 86400_000 : now - i * 10_000,
        officeSeat: i < 6 ? i : undefined,
        zone: i < 6 ? 'office' : i === 6 ? 'waiting' : 'archive',
        openCount: [12, 8, 3, 6, 2, 1, 4, 0][i],
        observedAt: now,
        statusEvidence: 'observed',
        statusReason: t.statusReason,
        sourcePath: 'demo',
        sourceKind: 'demo',
        sourceVersion: '1',
        partial: false,
        archived: false,
        pinned: false,
        parentId: null,
        usage: {
          input: 12400 + i * 1200,
          output: 2300 + i * 200,
          cached: 8400,
          total: 14700 + i * 1400,
          contextUsed: 12400,
          contextWindow: 200000,
          scope: 'session',
          source: t.usageSource,
        },
        events: [
          {
            id: `e-${i}-1`,
            at: now - 100000,
            kind: 'user',
            text: t.request(title),
            sourceRef: 'demo',
          },
          {
            id: `e-${i}-2`,
            at: now - 30000,
            kind: 'assistant',
            phase: i === 5 ? 'final' : 'commentary',
            text: t.message(action),
            sourceRef: 'demo',
          },
        ],
        artifacts:
          i === 0
            ? [
                'https://github.com/example/agent-office/pull/42',
                'https://github.com/example/agent-office/issues/18',
              ]
            : [],
        notes: '',
        revision: 'demo',
        completed: false,
      };
    }),
  };
  snapshot.notices = snapshot.sessions
    .filter((s) => s.zone === 'office')
    // Candidates are canonical, like stored notices: show them in the active language.
    .flatMap((s) => noticeCandidates(s, now, true).slice(-1))
    .map((n) => localizeNotice(n))
    .sort((a, b) => b.at - a.at);
  return snapshot;
}
