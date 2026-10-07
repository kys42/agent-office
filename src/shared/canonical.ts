import { LOCALES, getLocale, messagesFor, type Locale, type Messages } from './i18n';
import type { OfficeEvent, Preferences, Session } from './types';

/**
 * Canonical at rest, localized on read. Everything the collector writes itself (redaction
 * placeholders, status reasons, lifecycle and tool texts, fallbacks) is stored in one language:
 * the original Korean wording, byte-identical to what pre-i18n versions stored. Event ids,
 * notice versions, revisions and exclusions therefore never depend on the display language,
 * and existing rows stay valid. Every read path that leaves the store goes through these helpers.
 */
export const CANONICAL: Locale = 'ko';
export const canonical = (): Messages => messagesFor(CANONICAL);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Mirrors redact()'s `key=value` rule, which can re-match the first word of an earlier
// placeholder (`api_key=sk-…` → `api_key=[hidden] hidden]`). Such composites localize to exactly
// what redact() writes in the target language.
const SECRET_VALUE = /^[^\s"',;}&]+/;
function placeholders(locale: Locale): string[] {
  const r = messagesFor(locale).shared.redaction;
  const composite = (p: string) => r.hidden + p.replace(SECRET_VALUE, '');
  // Composites start with the plain placeholder, so they must be tried first.
  return [composite(r.privateKey), composite(r.token), r.privateKey, r.token, r.hidden];
}

type Phrase = (text: string) => string | undefined;
/** Fixed canonical phrases → target wording; numeric phrases (`4시간 …`) keep their number. */
function phrase(
  pairs: [string, string][],
  numeric: [(n: number) => string, (n: number) => string][] = [],
): Phrase {
  const exact = new Map(pairs);
  const patterns = numeric.map(([from, to]) => {
    const probe = 271828;
    const [head, tail] = from(probe).split(String(probe));
    return [new RegExp(`^${escape(head)}(\\d+)${escape(tail ?? '')}$`), to] as const;
  });
  return (text) => {
    const hit = exact.get(text);
    if (hit !== undefined) return hit;
    for (const [pattern, to] of patterns) {
      const match = pattern.exec(text);
      if (match) return to(Number(match[1]));
    }
  };
}
const strings = <T extends Record<string, unknown>>(from: T, to: T): [string, string][] =>
  Object.keys(from).flatMap((k) =>
    typeof from[k] === 'string' ? [[from[k] as string, to[k] as string]] : [],
  );

interface Book {
  tokens: RegExp;
  token: Map<string, string>;
  reason: Phrase;
  fallback: Phrase;
  lifecycle: Phrase;
}
const books = new Map<Locale, Book>();
function book(locale: Locale): Book {
  const cached = books.get(locale);
  if (cached) return cached;
  const a = canonical();
  const b = messagesFor(locale);
  const from = placeholders(CANONICAL);
  const to = placeholders(locale);
  const made: Book = {
    tokens: new RegExp(from.map(escape).join('|'), 'g'),
    token: new Map(from.map((p, i) => [p, to[i]])),
    reason: phrase(
      [
        ...strings(a.server.reason, b.server.reason),
        [a.server.session.openclawArchived, b.server.session.openclawArchived],
        [a.shared.runtime.archived, b.shared.runtime.archived],
        [a.shared.runtime.quiet, b.shared.runtime.quiet],
      ],
      [
        [a.shared.runtime.offDuty, b.shared.runtime.offDuty],
        [a.shared.runtime.ready, b.shared.runtime.ready],
      ],
    ),
    fallback: phrase([
      ...strings(a.shared.activity.fallback, b.shared.activity.fallback),
      [a.shared.activity.noProgress, b.shared.activity.noProgress],
    ]),
    lifecycle: phrase([
      [a.server.event.turnStarted, b.server.event.turnStarted],
      [a.server.event.turnCompleted, b.server.event.turnCompleted],
      [a.server.event.turnAborted, b.server.event.turnAborted],
    ]),
  };
  books.set(locale, made);
  return made;
}

/** Redaction placeholders inside collected free text, in `locale`. */
export function localizeText(text: string, locale: Locale = getLocale()): string {
  if (locale === CANONICAL || !text) return text;
  const { tokens, token } = book(locale);
  return text.replace(tokens, (hit) => token.get(hit) ?? hit);
}
/** A status reason the collector wrote (observed or derived at parse time). */
export const localizeReason = (reason: string, locale: Locale = getLocale()) =>
  locale === CANONICAL ? reason : (book(locale).reason(reason) ?? reason);
/** Any locale's "unknown workspace" is one project: compare and store the canonical name. */
export function canonicalProject(project: string): string {
  const unknown = canonical().server.session.unknownWorkspace;
  for (const locale of Object.keys(LOCALES) as Locale[])
    if (project === messagesFor(locale).server.session.unknownWorkspace) return unknown;
  return project;
}
export const localizeProject = (project: string, locale: Locale = getLocale()) =>
  project === canonical().server.session.unknownWorkspace
    ? messagesFor(locale).server.session.unknownWorkspace
    : project;
/** Excluded projects are stored canonical; settings list them in the display language. */
export const localizePreferences = (p: Preferences, locale: Locale = getLocale()): Preferences => ({
  ...p,
  excludedProjects: [
    ...new Set(p.excludedProjects.map((x) => localizeProject(canonicalProject(x), locale))),
  ],
});

function localizeEvent(e: OfficeEvent, locale: Locale): OfficeEvent {
  const from = canonical().server.event;
  const to = messagesFor(locale).server.event;
  let text: string | undefined;
  if (e.kind === 'lifecycle') text = book(locale).lifecycle(e.text);
  else if (e.kind === 'tool' && e.tool != null && e.text === from.toolRun(e.tool))
    text = to.toolRun(e.tool);
  else if (e.kind === 'result' && e.text === from.toolResult(e.tool ?? from.tool))
    text = to.toolResult(e.tool ?? to.tool);
  text ??= localizeText(e.text, locale);
  return text === e.text ? e : { ...e, text };
}
/** Activity fallbacks are fixed phrases; excerpts of public messages only carry placeholders. */
function activityText(text: string, kind: string | undefined, locale: Locale) {
  return (
    (kind === undefined || kind === 'status' ? book(locale).fallback(text) : undefined) ??
    localizeText(text, locale)
  );
}
function localizeTitle(s: Session, locale: Locale) {
  if (!s.nativeTitle) {
    const from = canonical().server.session;
    // The fallback title names the project seen at parse time; workspace detection may rename it.
    const cwdName = s.cwd?.split(/[\\/]/).filter(Boolean).at(-1);
    for (const project of [s.project, cwdName])
      if (project && s.title === from.untitled(project))
        return messagesFor(locale).server.session.untitled(localizeProject(project, locale));
  }
  return localizeText(s.title, locale);
}

/**
 * A stored (canonical) session in `locale`. User-written notes and aliases are never touched;
 * fields derived at read time (e.g. runtime reasons) are already in the active language.
 */
export function localizeSession<T extends Session>(s: T, locale: Locale = getLocale()): T {
  if (locale === CANONICAL) return s;
  const notCollected = canonical().server.session.usageNotCollected;
  return {
    ...s,
    title: localizeTitle(s, locale),
    project: localizeProject(s.project, locale),
    statusReason: localizeReason(s.statusReason, locale),
    ...(s.runtime
      ? { runtime: { ...s.runtime, reason: localizeReason(s.runtime.reason, locale) } }
      : {}),
    action: activityText(s.action, s.activity?.kind, locale),
    ...(s.activity
      ? {
          activity: { ...s.activity, text: activityText(s.activity.text, s.activity.kind, locale) },
        }
      : {}),
    usage:
      s.usage.source === notCollected
        ? { ...s.usage, source: messagesFor(locale).server.session.usageNotCollected }
        : s.usage,
    events: s.events.map((e) => localizeEvent(e, locale)),
  };
}
