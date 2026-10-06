import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import type { Provider, ProviderQuota, QuotaWindow } from '../src/shared/types.js';
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
  if (provider === 'claude') {
    for (const [key, label] of Object.entries({
      five_hour: '5시간',
      seven_day: '일주일',
      seven_day_sonnet: 'Sonnet · 일주일',
      seven_day_opus: 'Opus · 일주일',
      seven_day_fable: 'Fable · 일주일',
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
            ? '5시간'
            : mins === 10080
              ? '일주일'
              : typeof mins === 'number' && mins > 0
                ? `${mins >= 60 ? mins / 60 : mins}${mins >= 60 ? '시간' : '분'}`
                : '기간 미확인';
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
    const timer = setTimeout(
      () => finish(undefined, 'Codex 한도 조회 시간이 초과됐어요.'),
      timeout,
    );
    const send = (message: object) => {
      if (!done) child.stdin.write(JSON.stringify(message) + '\n');
    };
    child.on('error', () =>
      finish(undefined, 'Codex CLI를 실행할 수 없어요. 설치와 로그인을 확인해 주세요.'),
    );
    child.stdin.on('error', () => finish(undefined, 'Codex 조회 연결이 종료됐어요.'));
    child.on('close', () => finish(undefined, 'Codex 조회 연결이 종료됐어요.'));
    child.stderr.on('data', () => {}); // Never return raw diagnostics or authentication material.
    child.stdout.on('data', (chunk) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > 1024 * 1024) return finish(undefined, 'Codex 조회 응답이 너무 커요.');
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
        if (msg.error)
          return finish(
            undefined,
            'Codex 한도를 확인할 수 없어요. 원래 앱의 계정 로그인을 확인해 주세요.',
          );
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
  if (typeof token !== 'string' || !token)
    throw new Error('Claude Code의 구독 계정 로그인이 필요해요. API 키 계정은 구독 한도가 없어요.');
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
    throw new Error(
      response.status === 429
        ? 'Claude 조회가 잠시 제한됐어요. 잠시 후 다시 확인해 주세요.'
        : 'Claude 한도를 확인할 수 없어요. Claude Code에서 로그인 상태를 확인해 주세요.',
    );
  return response.json();
}
export class QuotaService {
  private cache = new Map<Provider, ProviderQuota>();
  private pending = new Map<Provider, Promise<ProviderQuota>>();
  constructor(
    private readers: Partial<Record<Provider, () => Promise<unknown>>> = {
      claude: claudeUsage,
      codex: codexUsage,
    },
  ) {}
  async read(provider: Provider): Promise<ProviderQuota> {
    const cached = this.cache.get(provider);
    if (cached && Date.now() - cached.checkedAt < 60_000) return cached;
    const pending = this.pending.get(provider);
    if (pending) return pending;
    const promise = (async (): Promise<ProviderQuota> => {
      const result: ProviderQuota = {
        provider,
        state: 'unavailable',
        windows: [],
        checkedAt: Date.now(),
        source:
          provider === 'codex'
            ? 'Codex CLI · account/rateLimits/read'
            : provider === 'claude'
              ? 'Claude OAuth usage'
              : 'OpenClaw',
        message: '',
      };
      try {
        const reader = this.readers[provider];
        if (!reader || provider === 'openclaw')
          result.message =
            'OpenClaw는 연결 모델별 한도를 사용해요. 통합 구독 한도는 제공하지 않아요.';
        else {
          result.windows = normalizeQuota(provider, await reader());
          result.state = result.windows.length ? 'ok' : 'unavailable';
          result.message = result.windows.length
            ? '현재 로그인 계정 전체의 한도 · 개별 세션의 잔여량이 아니에요.'
            : '현재 계정에서 한도 정보를 제공하지 않았어요.';
        }
      } catch {
        result.state = 'error';
        result.message =
          '조회하지 못했어요. 원래 앱의 로그인·네트워크를 확인하고 1분 후 다시 눌러 주세요.';
      }
      result.checkedAt = Date.now();
      this.cache.set(provider, result);
      return result;
    })();
    this.pending.set(provider, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(provider);
    }
  }
}
