import { z } from 'zod';
import type { Session, Snapshot, NoticePage } from '../../src/shared/types.js';
import { projectKey, sessionName } from '../../src/shared/office.js';
import { zoneLabel, zoneOptions } from '../../src/shared/zones.js';
const id = z.string().min(1).max(400);
export const READ_COMMANDS = new Set([
  'overview',
  'news',
  'search',
  'detail',
  'zones',
  'handoff',
  'show_agents',
  'show_briefing',
]);
export interface OfficeConnection {
  call(method: string, args?: unknown[]): Promise<any>;
  focus(id: string): void;
}
export function compactSession(s: Session) {
  return {
    id: s.id,
    name: sessionName(s),
    provider: s.provider,
    project: s.project,
    zone: s.zone,
    area: { key: projectKey(s), name: zoneLabel(s) },
    status: s.status,
    runtime: s.runtime,
    statusReason: s.statusReason,
    updatedAt: s.updatedAt,
    observedAt: s.observedAt,
    partial: s.partial,
    activity: s.activity,
    branch: s.branch,
    pinned: s.pinned,
    revision: s.revision,
  };
}
export async function officeAction(
  office: OfficeConnection,
  command: string,
  args: unknown,
  readonly: boolean,
) {
  if (readonly && !READ_COMMANDS.has(command))
    throw new Error('Scheduled summaries are read-only.');
  switch (command) {
    case 'show_agents': {
      const { ids } = z
        .object({ ids: z.array(id).min(1).max(8) })
        .strict()
        .parse(args);
      const agents = await Promise.all(
        [...new Set(ids)].map(async (id) => {
          const detail = await office.call('detail', [id]);
          const s: Session = detail.session ?? detail;
          return {
            id: s.id,
            name: sessionName(s),
            project: s.project,
            status: s.status,
            updatedAt: s.updatedAt,
          };
        }),
      );
      return { display: { type: 'agents', at: Date.now(), agents } };
    }
    case 'show_briefing': {
      z.object({}).strict().parse(args);
      const snapshot: Snapshot = await office.call('snapshot');
      const sessions = snapshot.sessions.filter((s) => !s.builtin && !s.archived);
      return {
        display: {
          type: 'briefing',
          at: snapshot.lastSync ?? Date.now(),
          total: sessions.length,
          working: sessions.filter((s) => ['work', 'think'].includes(s.status)).length,
          attention: sessions.filter((s) => ['call', 'error'].includes(s.status)).length,
          results: (snapshot.notices ?? []).filter(
            (n) =>
              !n.seenAt &&
              n.kind === 'reply' &&
              n.phase === 'final' &&
              n.sessionId !== 'office:manager',
          ).length,
        },
      };
    }
    case 'overview': {
      const { since } = z
        .object({ since: z.number().nonnegative().optional() })
        .strict()
        .parse(args);
      const s: Snapshot = await office.call('snapshot');
      return {
        locale: s.locale,
        observedAt: s.lastSync,
        connectors: s.connectors,
        scope: 'Collected records only; not proof of a live process or task success.',
        sessions: s.sessions.filter((s) => !s.builtin).map(compactSession),
        ...(await officeNews(office, since)),
        noticeStats: s.noticeStats,
      };
    }
    case 'news': {
      const a = z
        .object({
          since: z.number().nonnegative().optional(),
          before: z.object({ at: z.number(), id: z.string().max(1000) }).optional(),
        })
        .strict()
        .parse(args);
      return officeNews(office, a.since, a.before);
    }
    case 'search': {
      const { query } = z
        .object({ query: z.string().trim().min(1).max(200) })
        .strict()
        .parse(args);
      return (await office.call('search', [query])).slice(0, 20).map((h: any) => ({
        session: compactSession(h.session),
        snippet: h.snippet,
        eventId: h.eventId,
      }));
    }
    case 'detail':
      return office.call('detail', [z.object({ id }).strict().parse(args).id]);
    case 'zones': {
      z.object({}).strict().parse(args);
      const s: Snapshot = await office.call('snapshot');
      return zoneOptions(s.sessions, s.preferences.zoneRules);
    }
    case 'handoff': {
      const a = z
        .object({ id, revision: z.string().min(1).max(100) })
        .strict()
        .parse(args);
      return office.call('handoff', [a.id, a.revision]);
    }
    case 'move': {
      const a = z
        .object({
          id,
          zoneKey: z.string().min(1).max(1100).optional(),
          name: z.string().trim().min(1).max(40).optional(),
        })
        .strict()
        .parse(args);
      if (Boolean(a.zoneKey) === Boolean(a.name))
        throw new Error('Choose an existing zoneKey OR a new area name.');
      return office.call('managerMove', [a]);
    }
    case 'return': {
      const a = z.object({ id }).strict().parse(args);
      await office.call('returnToOffice', [a.id]);
      return { id: a.id, returned: true };
    }
    case 'pin': {
      const a = z.object({ id, on: z.boolean() }).strict().parse(args);
      await office.call('pin', [[a.id], a.on]);
      return { id: a.id, pinned: a.on };
    }
    case 'focus': {
      const a = z.object({ id }).strict().parse(args);
      await office.call('detail', [a.id]); // Apply the same exclusion policy before focusing.
      office.focus(a.id);
      return { id: a.id, focused: true };
    }
    default:
      throw new Error('Unknown Office command. Run ./office help.');
  }
}

/** Page durable notices rather than relying on the bounded live snapshot. */
async function officeNews(
  office: OfficeConnection,
  since?: number,
  before?: { at: number; id: string },
) {
  const page: NoticePage = await office.call('noticePage', [
    { filter: 'all', includeRead: true, includeBackground: true, limit: 80, before },
  ]);
  const notices = page.notices.filter((n) => since === undefined || n.at >= since);
  const last = page.notices.at(-1);
  const more = Boolean(page.more && last && (since === undefined || last.at >= since));
  return {
    notices: notices.map((n) => ({
      ...n,
      text: n.text.slice(0, 2000),
      truncated: n.text.length > 2000,
    })),
    moreNotices: more,
    nextBefore: more && last ? { at: last.at, id: last.id } : null,
  };
}
