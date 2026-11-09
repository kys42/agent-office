import type { OutputPreview, Session, SessionOutput } from './types';

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
/** Rows a work card shows before "see all". */
export const OUTPUT_CARD = 5;
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
