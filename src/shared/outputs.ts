import type { OfficeEvent, OutputPreview, Session, SessionOutput } from './types';

// Outputs a session made (#350): documents and other results, collected from its record only.
// The adapters say which files a session created (server/adapters/outputs.ts); this module holds
// the rules the collector, the desktop and the screens share.

/**
 * Kinds of file that count as an output: documents, data a person reads, images. Code never
 * counts, nor does anything else.
 */
export const OUTPUT_EXTENSIONS: ReadonlySet<string> = new Set([
  'md',
  'markdown',
  'html',
  'htm',
  'pdf',
  'csv',
  'tsv',
  'xlsx',
  'docx',
  'pptx',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'json',
]);
/** Folders whose files are never outputs: dependencies, VCS, build and test leftovers. */
export const OUTPUT_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'test-results',
  'playwright-report',
  'coverage',
  'dist',
  'build',
  '.local',
]);
/** JSON files that configure a project rather than report something. */
export const CONFIG_JSON =
  /^(?:package(?:-lock)?|tsconfig(?:\.[\w-]+)?|jsconfig|composer|deno|vercel|turbo|lerna|nx|renovate|\.?eslintrc|\.?prettierrc|\.?babelrc)\.json$/i;
export const OUTPUT_PAGE = 50;
export const OUTPUT_PAGE_MAX = 200;
/** Outputs kept in all (the oldest go first). */
export const OUTPUT_KEEP = 5000;
/** A preview reads at most this much of a file. */
export const OUTPUT_PREVIEW_BYTES = 1024 * 1024;

/** The extension of a file name, lower case, without the dot ('' when there is none). */
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** How the reader window shows an output, if it can: markdown, or HTML in a sandbox. */
export function previewFormat(ext: string): OutputPreview['format'] | null {
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  return null;
}

/**
 * Claude Artifact links in text: claude.ai/artifact/…, claude.ai/code/artifact/…,
 * claude.ai/public/artifacts/… (a markdown link's own title is read with it).
 */
const ARTIFACT_URL = String.raw`https:\/\/claude\.ai\/(?:[A-Za-z0-9_-]+\/){0,3}artifacts?\/[A-Za-z0-9_-]{6,128}`;
export const ARTIFACT_LINKS = new RegExp(
  String.raw`(?:\[([^\]\n]{1,200})\]\(\s*)?(${ARTIFACT_URL})(?![A-Za-z0-9_/-])`,
  'g',
);

/** A Claude Artifact link, as it may be opened (in the browser, on the person's click); else null. */
export function claudeArtifactLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 400) return null;
  const match = new RegExp(`^${ARTIFACT_URL}$`).exec(raw.trim());
  return match ? match[0] : null;
}

/** Newest first, then by id: one order for pages. */
export function outputOrder(a: SessionOutput, b: Pick<SessionOutput, 'createdAt' | 'id'>) {
  return b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/**
 * A list read again whose loaded rows reach past the refreshed first page (one read is bounded
 * by `OUTPUT_PAGE_MAX`): the new first page, then the rows loaded after it that are older than
 * its last row. Rows gone from the refreshed range go; the older tail stays as it was, so the
 * list does not fold back and the scroll stays put. Null when the page covers the whole list.
 */
export function refreshed(
  loaded: SessionOutput[],
  head: SessionOutput[],
  more: boolean,
): SessionOutput[] | null {
  const last = head.at(-1);
  if (!more || !last || loaded.length <= head.length) return null;
  const ids = new Set(head.map((o) => o.id));
  const tail = loaded.filter((o) => !ids.has(o.id) && outputOrder(o, last) > 0);
  return tail.length ? [...head, ...tail] : null;
}

/** Whether an output matches the words a list was narrowed by. */
export function outputMatches(o: SessionOutput, text: string) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay =
    `${o.name} ${o.path} ${o.source.project} ${o.source.title} ${o.source.alias}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Whose output it is: its colleague as shown now, else as recorded. */
export function outputOwner(o: SessionOutput, session?: Pick<Session, 'alias' | 'title'>) {
  return session ? session.alias || session.title : o.source.alias || o.source.title;
}

export interface OutputGroup {
  project: string;
  colleagues: { sessionId: string; name: string; outputs: SessionOutput[] }[];
}
/**
 * Outputs by project, then by colleague, each newest first; groups follow their newest output.
 * `sessions` is the office as shown now (a colleague's current name and project win).
 */
export function groupOutputs(list: SessionOutput[], sessions: Session[]): OutputGroup[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const groups = new Map<string, Map<string, SessionOutput[]>>();
  for (const o of [...list].sort(outputOrder)) {
    const s = byId.get(o.sessionId);
    const project = s?.project ?? o.source.project;
    const colleagues = groups.get(project) ?? new Map<string, SessionOutput[]>();
    groups.set(project, colleagues);
    colleagues.set(o.sessionId, [...(colleagues.get(o.sessionId) ?? []), o]);
  }
  return [...groups].map(([project, colleagues]) => ({
    project,
    colleagues: [...colleagues].map(([sessionId, outputs]) => ({
      sessionId,
      name: outputOwner(outputs[0], byId.get(sessionId)),
      outputs,
    })),
  }));
}

/** Where `placeOutputChips` puts outputs that wait for the reply of a turn still running. */
export const CHIPS_AT_END = '';

/**
 * Where the chat shows each output (#358): the visible message (or work group) under which its
 * chip row goes, by group id. `events` is the whole loaded conversation in order, `groups` what
 * the chat shows of it (a group lists its events). An output sits under the event that produced
 * it; that event hidden (a tool call with the work log folded, a progress note left out), under
 * the next visible reply of the same turn; with none yet in the last turn, at the end
 * (`CHIPS_AT_END`); else under the nearest visible message before it. An output whose event is
 * not loaded is placed by its time, unless that time falls on a page not read yet (`older`,
 * `newer`). Each row is ordered by time.
 */
export function placeOutputChips<
  O extends Pick<SessionOutput, 'id' | 'eventId' | 'eventAt' | 'createdAt'>,
>(
  events: readonly Pick<OfficeEvent, 'id' | 'legacyId' | 'kind' | 'at'>[],
  groups: readonly { id: string; events: readonly Pick<OfficeEvent, 'id'>[] }[],
  outputs: readonly O[],
  range: { older?: boolean; newer?: boolean } = {},
): Map<string, O[]> {
  const placed = new Map<string, O[]>();
  if (!events.length || !outputs.length) return placed;
  const index = new Map<string, number>();
  events.forEach((e, i) => {
    if (!index.has(e.id)) index.set(e.id, i);
    if (e.legacyId && !index.has(e.legacyId)) index.set(e.legacyId, i);
  });
  const shownIn = new Map<string, string>();
  for (const g of groups) for (const e of g.events) shownIn.set(e.id, g.id);
  const group = (i: number) => shownIn.get(events[i].id);
  const when = (o: O) => o.eventAt ?? o.createdAt;
  const first = events[0].at;
  const last = events.at(-1)!.at;
  const anchor = (from: number): string | undefined => {
    if (group(from)) return group(from);
    let j = from + 1;
    for (; j < events.length && events[j].kind !== 'user'; j++)
      if (events[j].kind === 'assistant' && group(j)) return group(j);
    // The last turn, still without a visible reply: at the end, until one comes.
    if (j === events.length && !range.newer) return CHIPS_AT_END;
    for (let k = from - 1; k >= 0; k--) if (group(k)) return group(k);
    for (let k = from + 1; k < events.length; k++) if (group(k)) return group(k);
  };
  for (const o of outputs) {
    let at = o.eventId === undefined ? undefined : index.get(o.eventId);
    if (at === undefined) {
      const t = when(o);
      // On a page not read yet: it comes with that page.
      if ((range.older && t < first) || (range.newer && t > last)) continue;
      at = 0;
      for (let i = 0; i < events.length && events[i].at <= t; i++) at = i;
    }
    const key = anchor(at);
    if (key === undefined) continue;
    const row = placed.get(key) ?? [];
    if (!row.some((x) => x.id === o.id)) row.push(o);
    placed.set(key, row);
  }
  for (const row of placed.values())
    row.sort((a, b) => when(a) - when(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return placed;
}
