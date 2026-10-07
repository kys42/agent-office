import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import type { Provider, ProviderQuota, QuotaWindow } from '../src/shared/types.js';
import { m } from '../src/shared/i18n/index.js';
const exec = promisify(execFile);
const percent = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function reset(v: unknown): number | null {
  const n =
    typeof v === 'number' ? v * (v < 1e11 ? 1000 : 1) : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
function windowValue(key: string, label: string, value: any): QuotaWindow | null {
  const used = value?.usedPercent ?? value?.utilization ?? value?.used_percentage;
  return percent(used)
    ? {
        key,
        label,
        usedPercent: Math.min(100, used),
        resetsAt: reset(value.resetsAt ?? value.resets_at),
      }
    : null;
}
export function normalizeQuota(provider: 'codex' | 'claude', data: any): QuotaWindow[] {
  const windows: (QuotaWindow | null)[] = [];
  const t = m().server.quota;
  if (provider === 'claude') {
    for (const [key, label] of Object.entries({
      five_hour: t.fiveHours,
      seven_day: t.week,
      seven_day_sonnet: `Sonnet · ${t.week}`,
      seven_day_opus: `Opus · ${t.week}`,
      seven_day_fable: `Fable · ${t.week}`,
    }))
      windows.push(windowValue(key, label, data?.[key]));
  } else {
    const limits =
      data?.rateLimitsByLimitId && Object.keys(data.rateLimitsByLimitId).length
        ? Object.entries(data.rateLimitsByLimitId)
        : [['codex', data?.rateLimits]];
    for (const [id, bucket] of limits as [string, any][]) {
      for (const key of ['primary', 'secondary']) {
        const w = bucket?.[key];
        if (!w) continue;
        const mins = w.windowDurationMins;
        const duration =
          mins === 300
            ? t.fiveHours
            : mins === 10080
              ? t.week
              : typeof mins === 'number' && mins > 0
                ? mins >= 60
                  ? t.hours(mins / 60)
                  : t.minutes(mins)
                : t.unknownWindow;
        windows.push(
          windowValue(`${id}:${key}`, `${id === 'codex' ? '' : `${id} · `}${duration}`, w),
        );
      }
    }
  }
  return windows.filter((w): w is QuotaWindow => w !== null);
}
const bundledCodex = '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex';
export function codexUsage(
  command = process.platform === 'darwin' && existsSync(bundledCodex) ? bundledCodex : 'codex',
  timeout = 12_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let done = false,
      buffer = '',
      bytes = 0;
    const finish = (value?: unknown, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill('SIGTERM');
      const kill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 1000);
      kill.unref();
      child.once('close', () => clearTimeout(kill));
      if (error) reject(new Error(error));
      else resolve(value);
    };
    const t = m().server.quota;
    const timer = setTimeout(() => finish(undefined, t.codexTimeout), timeout);
    const send = (message: object) => {
      if (!done) child.stdin.write(JSON.stringify(message) + '\n');
    };
    child.on('error', () => finish(undefined, t.codexMissing));
    child.stdin.on('error', () => finish(undefined, t.codexClosed));
    child.on('close', () => finish(undefined, t.codexClosed));
    child.stderr.on('data', () => {}); // Never return raw diagnostics or authentication material.
    child.stdout.on('data', (chunk) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > 1024 * 1024) return finish(undefined, t.codexTooLarge);
      buffer += chunk.toString();
      let end: number;
      while (!done && (end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== 1 && msg.id !== 2) continue;
        if (msg.error) return finish(undefined, t.codexUnavailable);
        if (msg.id === 1) {
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'account/rateLimits/read', params: {} });
        } else finish(msg.result);
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'agent_office_usage', version: '0.1.0' } },
    });
  });
}
async function claudeUsage(): Promise<unknown> {
  // Only the existing Claude Code credential, read locally and sent to its issuer.
  // No token refresh, browser cookies, login mutation, or model invocation.
  let credential: any;
  const config = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  try {
    credential = JSON.parse(await readFile(path.join(config, '.credentials.json'), 'utf8'));
  } catch {}
  if (
    !credential?.claudeAiOauth?.accessToken &&
    process.platform === 'darwin' &&
    !process.env.CLAUDE_CONFIG_DIR
  ) {
    try {
      const { stdout } = await exec(
        '/usr/bin/security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { timeout: 5000, maxBuffer: 100_000 },
      );
      credential = JSON.parse(stdout);
    } catch {}
  }
  const token = credential?.claudeAiOauth?.accessToken;
  const t = m().server.quota;
  if (typeof token !== 'string' || !token) throw new Error(t.claudeLogin);
  const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1.0',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(response.status === 429 ? t.claudeRateLimited : t.claudeUnavailable);
  return response.json();
}
/** What a provider returned; labels are built per read so a language switch never needs a refetch. */
interface QuotaOutcome {
  checkedAt: number;
  kind: 'data' | 'unsupported' | 'error';
  data?: unknown;
}
export class QuotaService {
  private cache = new Map<Provider, QuotaOutcome>();
  private pending = new Map<Provider, Promise<ProviderQuota>>();
  constructor(
    private readers: Partial<Record<Provider, () => Promise<unknown>>> = {
      claude: claudeUsage,
      codex: codexUsage,
    },
  ) {}
  private present(provider: Provider, outcome: QuotaOutcome): ProviderQuota {
    const t = m().server.quota;
    const result: ProviderQuota = {
      provider,
      state: 'unavailable',
      windows: [],
      checkedAt: outcome.checkedAt,
      source:
        provider === 'codex'
          ? 'Codex CLI · account/rateLimits/read'
          : provider === 'claude'
            ? 'Claude OAuth usage'
            : 'OpenClaw',
      message: '',
    };
    if (outcome.kind === 'unsupported') result.message = t.openclaw;
    else if (outcome.kind === 'error') {
      result.state = 'error';
      result.message = t.failed;
    } else {
      result.windows = normalizeQuota(provider as 'codex' | 'claude', outcome.data);
      result.state = result.windows.length ? 'ok' : 'unavailable';
      result.message = result.windows.length ? t.ok : t.empty;
    }
    return result;
  }
  async read(provider: Provider): Promise<ProviderQuota> {
    const cached = this.cache.get(provider);
    if (cached && Date.now() - cached.checkedAt < 60_000) return this.present(provider, cached);
    const pending = this.pending.get(provider);
    if (pending) return pending;
    const promise = (async (): Promise<ProviderQuota> => {
      let outcome: Omit<QuotaOutcome, 'checkedAt'>;
      try {
        const reader = this.readers[provider];
        if (!reader || provider === 'openclaw') outcome = { kind: 'unsupported' };
        else {
          const data = await reader();
          normalizeQuota(provider, data); // malformed data is a failed read, not an empty one
          outcome = { kind: 'data', data };
        }
      } catch {
        outcome = { kind: 'error' };
      }
      const result = { ...outcome, checkedAt: Date.now() };
      this.cache.set(provider, result);
      return this.present(provider, result);
    })();
    this.pending.set(provider, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(provider);
    }
  }
}
