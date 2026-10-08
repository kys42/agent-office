import {
  editLocation,
  readCommand,
  resetLocation,
  toolLocation,
  wrappedLocations,
} from './working-location.js';
import { latestTaskStart } from '../../src/shared/lifecycle.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveIdentity } from './identity.js';
import type {
  Mood,
  OfficeEvent,
  Provider,
  Session,
  Usage,
  UsageEntry,
  WorkingLocation,
} from '../../src/shared/types.js';
import { summarizeActivity } from '../../src/shared/activity.js';
import { runtimeObservation, deriveState } from '../../src/shared/runtime.js';
import { messagesFor, type Locale } from '../../src/shared/i18n/index.js';
import { CANONICAL, canonical } from '../../src/shared/canonical.js';
export { deriveState } from '../../src/shared/runtime.js';

type Obj = Record<string, any>;
/**
 * Tools that wait for the person: a question (AskUserQuestion, Codex request_user_input) or a
 * plan to approve (Claude Code plan mode ends with ExitPlanMode). Until their result arrives the
 * colleague is calling.
 */
export const REQUEST_INPUT_TOOL = /AskUserQuestion|request_user_input|ExitPlanMode/;
export const PLAN_APPROVAL_TOOL = /ExitPlanMode/;
/** The native tool-call id that pairs a call with its result, when the source provides one. */
const call = (value: unknown): Pick<OfficeEvent, 'callId'> =>
  typeof value === 'string' && value && value.length <= 200 ? { callId: value } : {};
const publicPhase = (value: unknown): OfficeEvent['phase'] =>
  value === 'commentary'
    ? 'commentary'
    : ['final', 'final_answer'].includes(String(value))
      ? 'final'
      : undefined;
export const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 20);
/**
 * Removes secrets. Collected records use the canonical placeholders (localized on read);
 * text written straight for a reader (notes, handoff) passes that reader's language.
 */
export function redact(value: unknown, limit = 6000, locale: Locale = CANONICAL): string {
  const t = messagesFor(locale).shared.redaction;
  return String(value ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(
      /-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?-----END [\w ]*PRIVATE KEY-----/g,
      t.privateKey,
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]+)\b/g,
      t.token,
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',;}&]+/gi,
      (_, prefix: string) => prefix + t.hidden,
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, () => `Bearer ${t.hidden}`)
    .slice(0, limit);
}
export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export function timestamp(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  const n = Date.parse(String(v ?? ''));
  return Number.isFinite(n) ? n : fallback;
}
export function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b) => b && ['text', 'input_text', 'output_text'].includes(b.type))
    .map((b) => b.text ?? '')
    .join('\n');
}
export function cleanPrompt(t: string): string {
  return (
    t
      .replace(
        /<(?:environment_context|permissions instructions|system-reminder|user_instructions|INSTRUCTIONS|available_skills|system)[^>]*>[\s\S]*?<\/(?:environment_context|permissions instructions|system-reminder|user_instructions|INSTRUCTIONS|available_skills|system)>/gi,
        '',
      )
      .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/gi, '')
      // Harness notes recorded in the user role are not the person's words.
      .replace(/<task-notification\b[^>]*>[\s\S]*?<\/task-notification>/gi, '')
      .replace(/^\s*\[Request interrupted by user[^\]\n]*\]\s*$/i, '')
      .replace(
        /<external_codex_apps_open_page\b[^>]*>[\s\S]*?<\/external_codex_apps_open_page>/gi,
        '',
      )
      .replace(/^# AGENTS\.md instructions[\s\S]*/, '')
      .replace(/^\s*## My request:\s*/i, '')
      .trim()
  );
}
export function cleanTitle(value: unknown): string {
  const text = cleanPrompt(String(value ?? ''));
  // A DB title can be a truncated prefix without its closing context tag.
  return /^\s*(?:#{1,3}\s*)?<(?:in-app-browser-context|environment_context|external_codex_apps_open_page|INSTRUCTIONS)\b/i.test(
    text,
  )
    ? ''
    : redact(text.replace(/\s+/g, ' ').trim(), 160);
}
export const emptyUsage = (): Usage => ({
  input: null,
  output: null,
  cached: null,
  total: null,
  contextUsed: null,
  contextWindow: null,
  scope: 'session',
  source: canonical().server.session.usageNotCollected,
});
export interface ParseOptions {
  provider: Provider;
  sourcePath: string;
  now?: number;
  mtime: number;
  partial?: boolean;
  agentName?: string;
  nativeId?: string;
  title?: string;
  cwd?: string;
  branch?: string;
  model?: string;
  sourceKind?: 'jsonl' | 'sqlite';
}
/** Parsed sessions are canonical (see src/shared/canonical.ts), whatever the display language. */
export function parseRecords(raw: Obj[], opt: ParseOptions): Session {
  const now = opt.now ?? Date.now();
  const t = canonical().server;
  const resolved = resolveIdentity(raw, opt);
  const { owner, relation } = resolved;
  const isSubagent = relation.kind === 'subagent';
  const ownerAt = timestamp(owner.timestamp ?? resolved.ownerRecord?.timestamp, 0);
  const records = raw
    .map((r, i) => ({ r, i, at: timestamp(r.timestamp, opt.mtime) }))
    .filter(({ r, at }) => !isSubagent || !ownerAt || at >= ownerAt || r.type === 'session_meta')
    .sort((a, b) => a.at - b.at || a.i - b.i);
  const authoritativeId = resolved.nativeId;
  let nativeId = authoritativeId;
  const sourceTitle = opt.title ?? resolved.title;
  let title = cleanTitle(sourceTitle),
    cwd = opt.cwd ?? null,
    branch = opt.branch ?? null,
    gitCommit: string | null = null,
    model = opt.model ?? null,
    version = 'unknown',
    parentId = relation.parentNativeId;
  let nativeTitle = !!cleanTitle(sourceTitle);
  let titleRank = nativeTitle ? 4 : 0;
  let startedAt = opt.mtime,
    updatedAt = 0,
    status: Mood = 'idle',
    reason = t.reason.saved,
    usage = emptyUsage();
  const events: OfficeEvent[] = [];
  const seen = new Map<string, number>();
  const usageByMessage = new Map<string, Usage>();
  const usageEntries = new Map<string, UsageEntry>();
  let workingLocation: WorkingLocation | undefined;
  const hasNativeUsage = records.some(
    ({ r }) => r.type === 'token_usage_record' && r.payload?.usage && r.payload?.response_id,
  );
  let lastCodexTotal: string | undefined;
  // Claude's Bash keeps its directory between calls (a cd persists until Claude Code resets it).
  // undefined = still where it launched; null = moved somewhere that can't be read literally.
  let shell: string | null | undefined;
  const locate = (name: string, args: unknown, at: number) => {
    const wrapped =
      name === 'functions.exec' ||
      (name === 'exec' &&
        typeof args === 'string' &&
        /tools\.(?:exec_command|apply_patch)/.test(args));
    // Other shell tools start each call in the turn's cwd (unless the call names a workdir).
    const here =
      name === 'Bash'
        ? shell === null
          ? undefined
          : (shell ?? cwd ?? undefined)
        : (cwd ?? undefined);
    const location = wrapped
      ? wrappedLocations(args, at, cwd ?? undefined).at(-1)
      : (editLocation(name, args, cwd ?? undefined, at) ?? toolLocation(name, args, at, here));
    if (name === 'Bash' && args && typeof (args as any).command === 'string') {
      const after = readCommand((args as any).command, here, at);
      if (after.moved) shell = after.dir ?? null;
    }
    if (location) workingLocation = location;
  };
  const add = (
    r: Obj,
    at: number,
    kind: OfficeEvent['kind'],
    text: string,
    tool?: string,
    suffix = '',
    metadata: Pick<OfficeEvent, 'phase' | 'lifecycle' | 'callId'> = {},
  ) => {
    if (!text.trim()) return;
    // An ordinal is local to a transport page, not a native event ID. Using it
    // across continuation files silently overwrites different turns.
    const fallback = hash(`${at}:${kind}:${text}`);
    const id = String(r.uuid ?? r.id ?? fallback) + suffix;
    const legacyId = String(r.uuid ?? r.id ?? r.ordinal ?? fallback) + suffix;
    const index = seen.get(id) ?? events.length;
    seen.set(id, index);
    events[index] = {
      id,
      ...(legacyId !== id ? { legacyId } : {}),
      at,
      kind,
      text: redact(text),
      tool,
      intent:
        kind === 'tool'
          ? REQUEST_INPUT_TOOL.test(tool ?? '')
            ? 'request-input'
            : 'tool-use'
          : undefined,
      ...metadata,
      sourceRef: `${opt.sourcePath}#${id}`,
    };
    updatedAt = Math.max(updatedAt, at);
    startedAt = Math.min(startedAt, at);
  };
  const set = (s: Mood, why: string) => {
    status = s;
    reason = why;
  };
  for (const { r, at } of records) {
    const p = r.payload ?? {};
    const m = r.message ?? {};
    if (r.sessionId && !authoritativeId) nativeId = r.sessionId;
    if (r.cwd) cwd = r.cwd;
    if (r.gitBranch) branch = r.gitBranch;
    if (r.version) version = String(r.version);
    if (r.type === 'session_meta' || r.type === 'session') {
      const metaId = p.id ?? p.session_id ?? p.thread_id ?? r.id ?? r.session_id;
      if (authoritativeId && metaId && metaId !== authoritativeId) continue;
      nativeId = authoritativeId;
      cwd = p.cwd ?? r.cwd ?? cwd;
      version = String(p.cli_version ?? r.version ?? version);
      branch = p.git?.branch ?? branch;
      gitCommit = p.git?.commit_hash ?? gitCommit;
      startedAt = Math.min(startedAt, timestamp(p.timestamp ?? r.timestamp, opt.mtime));
    }
    if (r.type === 'turn_context') {
      model = p.model ?? model;
      cwd = p.cwd ?? cwd;
    }
    if (r.type === 'model_change') model = r.modelId ?? model;
    const rank =
      r.type === 'custom-title' ? 4 : r.type === 'ai-title' ? 3 : r.type === 'agent-name' ? 2 : 0;
    const namedTitle = cleanTitle(r.customTitle ?? r.aiTitle ?? r.agentName ?? r.title);
    if (rank && rank >= titleRank && namedTitle) {
      title = namedTitle;
      titleRank = rank;
      nativeTitle = true;
    }
    if (r.type === 'summary' && !title) title = cleanTitle(r.summary);
    if (r.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type))
      locate(String(p.name ?? ''), p.arguments ?? p.input, at);
    if (Array.isArray(m.content))
      for (const b of m.content)
        if (['tool_use', 'toolCall'].includes(b.type))
          locate(String(b.name ?? ''), b.input ?? b.arguments, at);
    if (r.type === 'token_usage_record') {
      const sample = p.usage;
      if (
        p.response_id &&
        sample &&
        num(sample.input_tokens) !== null &&
        num(sample.output_tokens) !== null
      ) {
        const cached = num(sample.cached_input_tokens) ?? 0;
        const write = num(sample.cache_write_input_tokens) ?? 0;
        const id = `response:${p.response_id}`;
        usageEntries.set(id, {
          id,
          at,
          model,
          input: Math.max(0, sample.input_tokens - cached - write),
          output: sample.output_tokens,
          cached,
          cacheWrite: write,
          cacheWriteHour: 0,
        });
      }
      const u = p.thread_token_usage;
      if (u) {
        usage = {
          ...usage,
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          cached: num(u.cached_input_tokens),
          total: num(u.total_tokens),
          source: 'Codex thread_token_usage',
          scope: 'session',
        };
      }
    }
    if (r.type === 'event_msg') {
      const type = p.type;
      if (type === 'token_count' && p.info) {
        const u = p.info.total_token_usage;
        const last = p.info.last_token_usage;
        const totalKey =
          u && [u.input_tokens, u.output_tokens, u.cached_input_tokens, u.total_tokens].join(':');
        // A native last-request sample tied to the cumulative snapshot is stable
        // across repeated token_count notifications. Never sum cumulative totals.
        if (
          !hasNativeUsage &&
          last &&
          totalKey &&
          totalKey !== lastCodexTotal &&
          num(last.input_tokens) !== null &&
          num(last.output_tokens) !== null
        ) {
          const cached = num(last.cached_input_tokens) ?? 0;
          usageEntries.set(`codex:${totalKey}`, {
            id: `codex:${totalKey}`,
            at,
            model,
            input: Math.max(0, last.input_tokens - cached),
            output: last.output_tokens,
            cached,
            cacheWrite: 0,
            cacheWriteHour: 0,
          });
        }
        if (totalKey) lastCodexTotal = totalKey;
        if (u)
          usage = {
            ...usage,
            input: num(u.input_tokens),
            output: num(u.output_tokens),
            cached: num(u.cached_input_tokens),
            total: num(u.total_tokens),
            source: 'Codex total_token_usage',
            scope: 'session',
          };
        usage.contextWindow = num(p.info.model_context_window) ?? usage.contextWindow;
        usage.contextUsed = num(p.info.last_token_usage?.input_tokens) ?? usage.contextUsed;
      }
      if (type === 'task_started') {
        set('think', t.reason.taskStarted);
        add(r, at, 'lifecycle', t.event.turnStarted, undefined, '', { lifecycle: 'started' });
        usage.contextWindow = num(p.model_context_window) ?? usage.contextWindow;
      }
      if (type === 'task_complete') {
        set('done', t.reason.taskComplete);
        add(r, at, 'lifecycle', t.event.turnCompleted, undefined, '', { lifecycle: 'completed' });
      }
      if (type === 'turn_aborted') {
        set('idle', t.reason.turnAborted);
        add(r, at, 'lifecycle', t.event.turnAborted, undefined, '', { lifecycle: 'aborted' });
      }
      if (type === 'user_message') {
        const text = cleanPrompt(String(p.message ?? ''));
        if (!title && text) title = text.slice(0, 140);
        add(r, at, 'user', text);
        if (text) set('think', t.reason.afterUser);
      }
      if (type === 'agent_message' && !['analysis', 'reasoning'].includes(p.phase ?? p.channel))
        add(r, at, 'assistant', String(p.message ?? ''), undefined, '', {
          phase: publicPhase(p.phase ?? p.channel),
        });
    }
    if (r.type === 'response_item') {
      if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
        if (p.role === 'assistant' && ['analysis', 'reasoning'].includes(p.phase ?? p.channel))
          continue;
        const text =
          p.role === 'user' ? cleanPrompt(contentText(p.content)) : contentText(p.content);
        if (p.role === 'user' && !title && text) title = text.slice(0, 140);
        add({ ...r, id: p.id ?? r.id }, at, p.role, text, undefined, '', {
          phase: publicPhase(p.phase ?? p.channel),
        });
        if (p.role === 'user' && text) set('think', t.reason.afterUser);
      }
      if (['function_call', 'custom_tool_call'].includes(p.type)) {
        const tool = String(p.name ?? 'tool');
        add(
          { ...r, id: p.call_id ?? p.id },
          at,
          'tool',
          t.event.toolRun(tool),
          tool,
          '',
          call(p.call_id),
        );
        set(
          tool.includes('request_user_input') ? 'call' : 'work',
          tool.includes('request_user_input') ? t.reason.inputTool : t.reason.toolCall,
        );
      }
      if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
        add(
          { ...r, id: `${p.call_id ?? p.id}:result` },
          at,
          'result',
          String(typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '')).slice(
            0,
            1800,
          ),
          undefined,
          '',
          call(p.call_id),
        );
        set('work', t.reason.toolResultWaiting);
      }
    }
    if (['assistant', 'user', 'message'].includes(r.type) && m.role) {
      const role = m.role;
      const text = role === 'user' ? cleanPrompt(contentText(m.content)) : contentText(m.content);
      if (role === 'user' && !r.isMeta && text) {
        if (!title) title = text.slice(0, 140);
        add(r, at, 'user', text);
        set('think', t.reason.afterUser);
      }
      if (role === 'assistant') {
        model = m.model ?? model;
        if (!['analysis', 'reasoning'].includes(m.phase ?? m.channel))
          add(r, at, 'assistant', text, undefined, ':text', {
            phase:
              publicPhase(m.phase ?? m.channel) ??
              (['end_turn', 'stop'].includes(m.stop_reason ?? m.stopReason)
                ? 'final'
                : ['tool_use', 'toolUse'].includes(m.stop_reason ?? m.stopReason) ||
                    (Array.isArray(m.content) &&
                      m.content.some((b: Obj) => ['tool_use', 'toolCall'].includes(b.type)))
                  ? 'commentary'
                  : undefined),
          });
        if (text) set('think', t.reason.recentReply);
        const u = m.usage;
        if (u) {
          const input = num(u.input_tokens ?? u.input),
            output = num(u.output_tokens ?? u.output),
            cached = num(u.cache_read_input_tokens ?? u.cacheRead);
          const write = num(u.cache_creation_input_tokens ?? u.cacheWrite) ?? 0;
          const value: Usage = {
            ...emptyUsage(),
            input,
            output,
            cached,
            total:
              num(u.totalTokens) ??
              (input !== null && output !== null ? input + output + (cached ?? 0) + write : null),
            contextUsed: input === null ? null : input + (cached ?? 0) + write,
            source: opt.provider === 'claude' ? 'Claude message.usage' : 'OpenClaw message.usage',
            scope: opt.partial ? 'sample' : 'session',
          };
          const key = String(m.id ?? r.id ?? r.uuid ?? at);
          if (input !== null && output !== null) {
            const hour = num(u.cache_creation?.ephemeral_1h_input_tokens) ?? 0;
            const entry: UsageEntry = {
              id: `message:${key}`,
              at,
              model,
              input,
              output,
              cached: cached ?? 0,
              cacheWrite: Math.max(0, write - hour),
              cacheWriteHour: hour,
            };
            if (!usageEntries.has(entry.id) || usageEntries.get(entry.id)!.output <= output)
              usageEntries.set(entry.id, entry);
          }
          const prev = usageByMessage.get(key);
          if (!prev || (value.output ?? 0) >= (prev.output ?? 0)) usageByMessage.set(key, value);
        }
        if (['end_turn', 'stop'].includes(m.stop_reason ?? m.stopReason)) {
          set('done', t.reason.replyEnded);
        }
      }
      if (Array.isArray(m.content))
        for (const [i, b] of m.content.entries()) {
          if (['tool_use', 'toolCall'].includes(b.type)) {
            const tool = String(b.name ?? 'tool');
            add(
              { ...r, id: b.id ?? r.id ?? r.uuid },
              at,
              'tool',
              t.event.toolRun(tool),
              tool,
              `:tool${i}`,
              call(b.id),
            );
            set(
              REQUEST_INPUT_TOOL.test(tool) ? 'call' : 'work',
              PLAN_APPROVAL_TOOL.test(tool) ? t.reason.planApproval : t.reason.toolCall,
            );
          }
          if (b.type === 'tool_result') {
            // Claude Code puts the shell back after a cd outside the project, and says so.
            shell = resetLocation(contentText(b.content)) ?? shell;
            add(
              { ...r, id: b.tool_use_id ?? r.uuid },
              at,
              'result',
              contentText(b.content) || String(b.content ?? '').slice(0, 1800),
              undefined,
              ':result',
              call(b.tool_use_id),
            );
            set('work', t.reason.toolResultRecovering);
          }
        }
      if (role === 'toolResult') {
        add(r, at, 'result', text || t.event.toolResult(m.toolName ?? t.event.tool), m.toolName);
        set('work', t.reason.toolResult);
      }
    }
  }
  if (usageByMessage.size) {
    const values = [...usageByMessage.values()];
    const sum = (k: 'input' | 'output' | 'cached' | 'total') =>
      values.some((v) => v[k] !== null) ? values.reduce((n, v) => n + (v[k] ?? 0), 0) : null;
    usage = {
      ...values.at(-1)!,
      input: sum('input'),
      output: sum('output'),
      cached: sum('cached'),
      total: sum('total'),
    };
  }
  nativeId = authoritativeId ?? nativeId;
  updatedAt = updatedAt || opt.mtime;
  const state = deriveState(status, updatedAt, now, false, undefined, undefined, CANONICAL);
  const project = cwd ? path.basename(cwd) : (opt.agentName ?? t.session.unknownWorkspace);
  const activity = summarizeActivity(events, status, updatedAt, CANONICAL);
  const action = activity.text;
  const artifacts = [
    ...new Set(
      events.flatMap(
        (e) => e.text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+/g) ?? [],
      ),
    ),
  ].slice(-12);
  return {
    protocolVersion: 1,
    id: `${opt.provider}:${opt.agentName ? opt.agentName + ':' : ''}${nativeId}`,
    nativeId,
    identity: resolved.identity,
    sourcePaths: [opt.sourcePath],
    provider: opt.provider,
    agentName: opt.agentName,
    actor:
      opt.provider === 'openclaw' && opt.agentName
        ? {
            id: `openclaw:${opt.agentName}`,
            name: opt.agentName,
            source: 'OpenClaw agent directory',
          }
        : undefined,
    origin: resolved.origin,
    title: redact(title || t.session.untitled(project), 160),
    nativeTitle,
    alias: '',
    project: redact(project, 120),
    cwd,
    workingLocation,
    usageEntries: [...usageEntries.values()],
    branch: redact(branch) || null,
    gitCommit,
    model,
    startedAt,
    taskStartedAt: latestTaskStart(events),
    updatedAt,
    observedAt: now,
    status: state.status,
    observedStatus: status,
    runtime: runtimeObservation(status, updatedAt, reason),
    statusEvidence: state.reason ? 'derived' : 'observed',
    statusReason: state.reason ?? reason,
    action,
    activity,
    sourcePath: opt.sourcePath,
    sourceKind: opt.sourceKind ?? 'jsonl',
    sourceVersion: version,
    partial: !!opt.partial || events.length > 180,
    archived: false,
    pinned: false,
    parentId,
    relation: { ...relation, parentNativeId: parentId },
    usage,
    events: events.slice(-180),
    artifacts,
    notes: '',
    revision: hash(
      `${nativeId}:${updatedAt}:${events.length}:${action}:${JSON.stringify([...usageEntries.values()])}:${JSON.stringify(workingLocation)}`,
    ),
    completed: false,
  };
}
