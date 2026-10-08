import type { ProviderQuota, QuotaWindow, Session } from './types';

/** A read older than this is not evidence of anything now (the pull runs every few minutes). */
export const QUOTA_STALE_MS = 30 * 60_000;

/** Which sessions a limit binds: the whole account, or one model family. */
export type QuotaScope = { kind: 'account' } | { kind: 'model'; model: string };

export interface QuotaExhaustion {
  provider: Session['provider'];
  /** The used-up limits that bind this session, each with its own reset time. */
  windows: (QuotaWindow & { scope: QuotaScope })[];
  checkedAt: number;
  /** When every binding limit is back (the latest known reset), if known. */
  backAt: number | null;
}

// Claude's weekly limits per model family; the rest (five_hour, seven_day) cover the account.
const CLAUDE_MODEL_KEYS: Record<string, string> = {
  seven_day_sonnet: 'sonnet',
  seven_day_opus: 'opus',
  seven_day_fable: 'fable',
};

/**
 * The scope of one limit window, from its key alone (see server/quotas.ts `normalizeQuota`).
 * Codex keys are `<limitId>:primary|secondary`; the plain `codex` id is the account's limit,
 * any other id names the model it limits.
 */
export function quotaScope(provider: Session['provider'], key: string): QuotaScope {
  if (provider === 'claude') {
    const model = CLAUDE_MODEL_KEYS[key];
    return model ? { kind: 'model', model } : { kind: 'account' };
  }
  const id = key.split(':')[0];
  return !id || id === 'codex' ? { kind: 'account' } : { kind: 'model', model: id };
}

const binds = (scope: QuotaScope, s: Session) =>
  scope.kind === 'account' ||
  // A model limit is only claimed for a session whose model is known to be that model.
  (!!s.model && s.model.toLowerCase().includes(scope.model.toLowerCase()));

/**
 * The limits this session's tool has fully used right now, or nothing. Only a fresh, successful
 * read counts: a failed, missing or stale read is "unknown", never "exhausted". A window whose
 * reset time has passed is back, even before the next read.
 */
export function quotaExhaustion(
  s: Session,
  quotas: readonly ProviderQuota[],
  now = Date.now(),
): QuotaExhaustion | undefined {
  const q = quotas.find((x) => x.provider === s.provider);
  if (!q || q.state !== 'ok' || now - q.checkedAt > QUOTA_STALE_MS) return undefined;
  const windows = q.windows
    .filter((w) => w.usedPercent >= 100 && (w.resetsAt === null || w.resetsAt > now))
    .map((w) => ({ ...w, scope: quotaScope(q.provider, w.key) }))
    .filter((w) => binds(w.scope, s));
  if (!windows.length) return undefined;
  const resets = windows.map((w) => w.resetsAt);
  return {
    provider: q.provider,
    windows,
    checkedAt: q.checkedAt,
    backAt: resets.includes(null) ? null : Math.max(...(resets as number[])),
  };
}

/**
 * Lights go out only on a desk that is not doing anything the person must see: a running
 * turn, a call or an error keeps its own look (the badge still says the limit is used up).
 */
export const dimsDesk = (s: Session, working: boolean) =>
  !working && s.status !== 'call' && s.status !== 'error';
