import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  getLocale,
  messagesFor,
  resolveLocale,
  setLocale,
  type Locale,
} from '../src/shared/i18n/index.js';
import { MOODS, PROVIDERS } from '../src/shared/types.js';
import { summarizeActivity } from '../src/shared/activity.js';
import { NOTICE_LABELS, localizeNotice, noticeCandidates } from '../src/shared/notices.js';
import { localizeSession, localizeText } from '../src/shared/canonical.js';
import type { Session, Snapshot } from '../src/shared/types.js';
import { TRIAGE_LABELS, durationShort } from '../src/shared/triage.js';
import { officeSchedule } from '../src/shared/lifecycle.js';
import { deriveState } from '../src/shared/runtime.js';
import { FOCUS_LABELS, POSTURE_LABELS } from '../src/shared/presentation.js';
import { TONE_LABELS } from '../src/shared/speech.js';
import { PET_LABELS, residentLabel } from '../src/shared/office-model.js';
import { cleanInput } from '../desktop/terminals.js';
import { parseRecords, redact } from '../server/adapters/normalize.js';
import { readOpenClawDatabases } from '../server/adapters/openclaw.js';
import { normalizeQuota } from '../server/quotas.js';
import { OfficeStore } from '../server/store.js';
import { OfficeService } from '../server/service.js';
import { systemLanguages } from '../server/locale.js';
import { demoSnapshot } from '../src/lib/demo.js';
// Deterministic regardless of the machine language: `auto` resolves to English here.
process.env.AGENT_OFFICE_LOCALE = 'en';
const hangul = /[가-힣]/;
const now = Date.now();
const opts = { provider: 'codex' as const, sourcePath: '/test/i18n.jsonl', mtime: now, now };

test('An explicit language wins; auto takes the first supported system language, else English', () => {
  assert.equal(resolveLocale('ko', ['en-US']), 'ko');
  assert.equal(resolveLocale('en', ['ko-KR']), 'en');
  assert.equal(resolveLocale('auto', ['ko-KR']), 'ko');
  assert.equal(resolveLocale(undefined, ['ko_KR.UTF-8']), 'ko');
  assert.equal(resolveLocale('auto', ['ja-JP']), 'en');
  assert.equal(resolveLocale('auto', ['ja-JP', 'ko-KR']), 'ko');
  assert.equal(resolveLocale('auto', []), 'en');
  assert.equal(resolveLocale(undefined), 'en');
  assert.equal(resolveLocale('auto', [null, undefined, '', 'C.UTF-8']), 'en');
});

test('The collector reads the deterministic override before system languages', () => {
  const saved = { ...process.env };
  try {
    process.env.AGENT_OFFICE_LOCALE = 'ko';
    process.env.AGENT_OFFICE_SYSTEM_LANGUAGES = 'ja-JP, en-US';
    const tags = systemLanguages();
    assert.deepEqual(tags.slice(0, 3), ['ko', 'ja-JP', 'en-US']);
    assert.equal(resolveLocale('auto', tags), 'ko');
    delete process.env.AGENT_OFFICE_LOCALE;
    assert.equal(resolveLocale('auto', ['ja-JP', 'en-US']), 'en');
  } finally {
    process.env = saved;
  }
});

test('Every language has exactly the shape of the English catalog', () => {
  const shape = (a: unknown, b: unknown, at: string) => {
    if (typeof a === 'function') {
      assert.equal(typeof b, 'function', `${at} must be a function`);
      return;
    }
    if (Array.isArray(a)) {
      assert.ok(Array.isArray(b), `${at} must be an array`);
      assert.equal((b as unknown[]).length, a.length, `${at} length`);
      a.forEach((x, i) => shape(x, (b as unknown[])[i], `${at}[${i}]`));
      return;
    }
    if (a && typeof a === 'object') {
      assert.ok(b && typeof b === 'object' && !Array.isArray(b), `${at} must be an object`);
      assert.deepEqual(
        Object.keys(b as object).sort(),
        Object.keys(a).sort(),
        `${at} keys must match`,
      );
      for (const key of Object.keys(a))
        shape((a as any)[key], (b as any)[key], at ? `${at}.${key}` : key);
      return;
    }
    assert.equal(typeof b, typeof a, `${at} type`);
    if (typeof a === 'string' && a) assert.ok((b as string).length > 0, `${at} must not be empty`);
  };
  shape(messagesFor('en'), messagesFor('ko'), '');
});

test('Shared labels read the active language at use time, never at import time', () => {
  setLocale('en');
  assert.equal(MOODS.call.label, 'Calling you');
  assert.equal(MOODS.call.color, '#ff7a8a');
  assert.equal(PROVIDERS.codex.description, 'Session logs · title DB');
  assert.equal(NOTICE_LABELS.reply, 'Final reply');
  assert.equal(TRIAGE_LABELS.attention, 'Waiting on you');
  assert.deepEqual(Object.keys(NOTICE_LABELS), [
    'request',
    'progress',
    'reply',
    'message',
    'attention',
    'error',
  ]);
  assert.equal(durationShort(75 * 60_000), '1h 15m in');
  assert.equal(
    officeSchedule({ standbyHours: 24, archiveDays: 1 }),
    'Standing by 30 min · Off duty after 1 day · Archive after 1 day',
  );
  assert.equal(summarizeActivity([], 'done', now).text, 'Finished this reply');
  assert.equal(
    normalizeQuota('claude', { seven_day_opus: { utilization: 3 } })[0].label,
    'Opus · 1 week',
  );
  setLocale('ko');
  assert.equal(MOODS.call.label, '불러요');
  assert.equal(NOTICE_LABELS.reply, '최종 응답');
  assert.equal(summarizeActivity([], 'done', now).text, '이번 응답을 마쳤어요');
  setLocale('en');
});

test('The status ladder speaks the active language: standing by, then off duty', () => {
  const hour = 3600_000;
  const t = Date.now();
  setLocale('en');
  assert.equal(MOODS.ready.label, 'Standing by');
  assert.equal(MOODS.sleep.label, 'Off duty');
  assert.equal(TRIAGE_LABELS.standby, 'Standing by');
  assert.equal(PET_LABELS.standby, 'Standing by');
  assert.equal(POSTURE_LABELS.standby, 'Waiting at the desk for the next request');
  assert.equal(TONE_LABELS.mine, 'My request');
  assert.deepEqual([...FOCUS_LABELS], ['Working', 'Focused', 'In the zone', 'On fire']);
  assert.equal(FOCUS_LABELS[3], 'On fire');
  assert.equal(
    deriveState('done', t - 5 * 60_000, t).reason,
    'Finished and standing by · waiting 30 min for new records',
  );
  assert.equal(
    deriveState('work', t - 5 * hour, t).reason,
    'No new records for 4 hours+ · not confirmed whether it stopped running',
  );
  assert.equal(
    officeSchedule({}),
    'Standing by 30 min · Off duty after 4 hours · Archive after 7 days',
  );
  const s = { ...demoSnapshot().sessions[0], provider: 'claude' as const };
  assert.equal(residentLabel(s, true).project, 'Project');
  assert.throws(() => cleanInput('  '), /Type something to send/);
  assert.throws(() => cleanInput('x'.repeat(4001)), /4,000 characters/);
  setLocale('ko');
  assert.equal(MOODS.ready.label, '대기 중');
  assert.equal(MOODS.sleep.label, '퇴근');
  assert.equal(TRIAGE_LABELS.standby, '대기 중');
  assert.deepEqual([...FOCUS_LABELS], ['작업 중', '집중 중', '몰입 중', '불타는 중']);
  assert.equal(
    deriveState('done', t - 5 * 60_000, t).reason,
    '일을 마치고 대기 중 · 30분 동안 새 기록을 기다려요',
  );
  assert.equal(officeSchedule({}), '30분 대기 · 4시간 후 퇴근 · 7일 후 보관');
  assert.throws(() => cleanInput('x'.repeat(4001)), /4,000자 이하로 보내 주세요/);
  setLocale('en');
});

test('The demo office is written in the active language with the same desks', () => {
  const sample = (locale: Locale) => {
    setLocale(locale);
    return demoSnapshot();
  };
  const en = sample('en');
  const ko = sample('ko');
  setLocale('en');
  assert.equal(en.sessions[0].alias, 'Coco');
  assert.equal(ko.sessions[0].alias, '코코');
  assert.ok(!hangul.test(JSON.stringify(en)));
  const layout = (s: typeof en) =>
    s.sessions.map((x) => [x.id, x.provider, x.project, x.status, x.zone, x.officeSeat]);
  assert.deepEqual(layout(en), layout(ko));
  assert.deepEqual(
    en.notices?.map((n) => n.id),
    ko.notices?.map((n) => n.id),
  );
});

const ko = messagesFor('ko');
const en = messagesFor('en');
const secret = `OPENAI_API_KEY=sk-proj-${'a1B2'.repeat(6)}`;

test('Parsing is canonical: the same session, ids and versions in every display language', () => {
  const records = [
    {
      type: 'event_msg',
      timestamp: new Date(now - 3000).toISOString(),
      payload: { type: 'task_started' },
    },
    {
      type: 'event_msg',
      timestamp: new Date(now - 2000).toISOString(),
      payload: { type: 'agent_message', message: `Deploy with ${secret} now`, phase: 'final' },
    },
    {
      type: 'event_msg',
      timestamp: new Date(now - 1500).toISOString(),
      payload: { type: 'task_complete' },
    },
    {
      type: 'response_item',
      timestamp: new Date(now - 1000).toISOString(),
      payload: { type: 'function_call', name: 'request_user_input' },
    },
  ];
  const parse = (locale: Locale) => {
    setLocale(locale);
    const s = parseRecords(records, opts);
    return { s, notices: noticeCandidates(s, now) };
  };
  const inEnglish = parse('en');
  const inKorean = parse('ko');
  setLocale('en');
  // Byte-identical, including text the collector writes itself (the original Korean wording).
  assert.deepEqual(inEnglish, inKorean);
  const { s, notices } = inEnglish;
  assert.equal(s.project, ko.server.session.unknownWorkspace);
  assert.equal(s.statusReason, ko.server.reason.inputTool);
  assert.ok(s.events.some((e) => e.text === ko.server.event.turnStarted));
  assert.ok(notices.some((n) => n.kind === 'attention' && n.text === ko.shared.notice.attention));
  // Readers localize: English shows English, Korean is the stored text itself.
  const shown = localizeSession(s, 'en');
  assert.equal(localizeSession(s, 'ko'), s);
  assert.equal(shown.project, 'Unknown workspace');
  assert.equal(shown.title, 'Unknown workspace work');
  assert.equal(shown.statusReason, en.server.reason.inputTool);
  assert.equal(shown.runtime?.reason, en.server.reason.inputTool);
  assert.equal(shown.usage.source, en.server.session.usageNotCollected);
  assert.deepEqual(
    shown.events.map((e) => e.text),
    [
      en.server.event.turnStarted,
      'Deploy with OPENAI_API_KEY=[hidden] hidden] now',
      en.server.event.turnCompleted,
      en.server.event.toolRun('request_user_input'),
    ],
  );
  assert.deepEqual(
    shown.events.map((e) => e.id),
    s.events.map((e) => e.id),
  );
  assert.ok(!hangul.test(JSON.stringify(shown)));
  const attention = localizeNotice(
    notices.find((n) => n.kind === 'attention')!,
    'en',
  );
  assert.equal(attention.text, en.shared.notice.attention);
  assert.equal(redact('password=hunter2'), `password=${ko.shared.redaction.hidden}`);
  assert.equal(redact('password=hunter2', 6000, 'en'), 'password=[hidden]');
});

test('Localized placeholders read exactly as that language would redact them', () => {
  const samples = [
    secret,
    'token=ghp_abcdefghijklmnopqrstu and Bearer abc.def',
    'secret: -----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY----- done',
    '-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY----- xoxb-1-2 sk-1234567890abcdefghij',
    'authorization: Bearer abc password="p" api_key=sk-abcdefghijklmnopqrstuv',
  ];
  for (const text of samples) {
    assert.equal(localizeText(redact(text), 'en'), redact(text, 6000, 'en'), text);
    assert.equal(localizeText(redact(text), 'ko'), redact(text), text);
  }
});

test('Fallback titles, activity fallbacks and archived reasons are localized on read', () => {
  const s = parseRecords(
    [
      {
        type: 'session_meta',
        timestamp: new Date(now - 9 * 3600_000).toISOString(),
        payload: { id: 'untitled', cwd: '/work/repo/packages/web' },
      },
    ],
    { ...opts, mtime: now - 9 * 3600_000 },
  );
  assert.equal(s.title, ko.server.session.untitled('web'));
  assert.equal(s.statusReason, ko.shared.runtime.offDuty(4));
  assert.equal(s.action, ko.shared.activity.fallback.idle);
  const moved = localizeSession({ ...s, project: 'repo' }, 'en');
  assert.equal(moved.title, 'web work');
  assert.equal(moved.statusReason, en.shared.runtime.offDuty(4));
  assert.equal(moved.action, en.shared.activity.fallback.idle);
  assert.equal(moved.activity?.text, en.shared.activity.fallback.idle);
  assert.equal(moved.usage.source, en.server.session.usageNotCollected);
  // A native title that merely looks like a fallback is the person's own text.
  const native = localizeSession({ ...s, nativeTitle: true }, 'en');
  assert.equal(native.title, s.title);
  // Tool results without a tool name keep the structured fallback word.
  const result = parseRecords(
    [
      {
        type: 'message',
        id: 'r1',
        timestamp: new Date(now).toISOString(),
        message: { role: 'toolResult', content: [] },
      },
    ],
    { ...opts, provider: 'openclaw', agentName: 'butler' },
  );
  assert.equal(result.events[0].text, ko.server.event.toolResult(ko.server.event.tool));
  assert.equal(localizeSession(result, 'en').events[0].text, 'Tool result');
  assert.equal(localizeSession(result, 'en').project, 'butler');
});

test('OpenClaw revisions and records do not depend on the display language', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-claw-i18n-'));
  try {
    const agent = path.join(dir, 'butler', 'agent');
    await mkdir(agent, { recursive: true });
    const db = new DatabaseSync(path.join(agent, 'openclaw-agent.sqlite'));
    db.exec(
      'CREATE TABLE session_nodes(current_session_id TEXT,entry_json TEXT,updated_at INTEGER,status TEXT,label TEXT,display_name TEXT,parent_session_key TEXT,archived_at INTEGER);CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT)',
    );
    db.prepare('INSERT INTO session_nodes VALUES (?,?,?,?,?,?,?,?)').run(
      's1',
      '{}',
      now,
      'done',
      null,
      null,
      null,
      now,
    );
    db.prepare('INSERT INTO transcript_events VALUES (?,?,?)').run(
      's1',
      1,
      JSON.stringify({
        type: 'message',
        id: 'e1',
        timestamp: now,
        message: { role: 'assistant', content: [{ type: 'text', text: `Set ${secret}` }] },
      }),
    );
    db.close();
    const read = async (locale: Locale) => {
      setLocale(locale);
      return (await readOpenClawDatabases(dir, 10, new Map())).sessions;
    };
    const stable = (list: Session[]) => list.map(({ observedAt: _, ...rest }) => rest);
    const inEnglish = await read('en');
    const inKorean = await read('ko');
    setLocale('en');
    assert.deepEqual(stable(inEnglish), stable(inKorean));
    assert.equal(inEnglish[0].statusReason, ko.server.session.openclawArchived);
    const shown = localizeSession(inEnglish[0], 'en');
    assert.equal(shown.statusReason, en.server.session.openclawArchived);
    assert.equal(shown.title, 'butler work');
    assert.ok(shown.events[0].text.includes('[hidden]'));
  } finally {
    setLocale('en');
    await rm(dir, { recursive: true, force: true });
  }
});

test('Handoff Markdown is written in English when English is active', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-i18n-'));
  const store = new OfficeStore(dir);
  try {
    setLocale('en');
    const s = parseRecords(
      [
        {
          type: 'event_msg',
          timestamp: new Date(now).toISOString(),
          payload: { type: 'user_message', message: 'Tidy up the login form' },
        },
      ],
      opts,
    );
    store.upsert([s], 'codex');
    assert.throws(() => store.handoff(s.id, 'old'), /record has changed/);
    const { markdown } = store.handoff(s.id, s.revision);
    assert.match(markdown, /^# .+ · Handoff\n/);
    assert.ok(markdown.includes('## Recent evidence'));
    assert.ok(markdown.includes('- Model: Not collected'));
    assert.ok(markdown.includes('- Project: Unknown workspace'));
    assert.ok(!hangul.test(markdown));
    // The MCP server: errors in the active language (English), the packet in the office language.
    assert.throws(() => store.handoff(s.id, 'old', 'ko'), /record has changed/);
    const korean = store.handoff(s.id, s.revision, 'ko').markdown;
    assert.ok(korean.includes(ko.server.handoff.title('Tidy up the login form')));
    assert.ok(
      korean.includes(
        `- ${ko.server.handoff.field.project}: ${ko.server.session.unknownWorkspace}`,
      ),
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const rollout = async (root: string, id: string, lines: object[]) =>
  writeFile(
    path.join(root, `rollout-${id}.jsonl`),
    lines.map((x) => JSON.stringify(x)).join('\n') + '\n',
  );
const at = (offset: number) => new Date(now - offset).toISOString();
async function office(prefix: string) {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(temp, 'sessions');
  await mkdir(root);
  const service = new OfficeService(path.join(temp, 'data'), temp);
  service.roots.codex = root;
  service.store.preferences({ enabledProviders: ['codex'] });
  return {
    root,
    service,
    language: (locale: 'auto' | Locale) =>
      service.call('preferences', [{ locale }]) as Promise<Snapshot>,
    async close() {
      service.stop();
      setLocale('en');
      await rm(temp, { recursive: true, force: true });
    },
  };
}

test('Switching language re-renders on read: same revisions, notices stay read', async () => {
  const o = await office('office-switch-');
  const id = '01a102c7-f8f8-71a0-82a0-bbbb4defdf64';
  const long = `Rotated ghp_${'k'.repeat(24)} for you. ${'Details follow. '.repeat(70)}`;
  await rollout(o.root, id, [
    { type: 'session_meta', timestamp: at(6000), payload: { id } },
    { type: 'event_msg', timestamp: at(5000), payload: { type: 'user_message', message: 'Hi' } },
    {
      type: 'event_msg',
      timestamp: at(4000),
      payload: { type: 'agent_message', message: `Set ${secret} in .env`, phase: 'final' },
    },
    {
      type: 'event_msg',
      timestamp: at(3000),
      payload: { type: 'agent_message', message: long, phase: 'final' },
    },
    {
      type: 'response_item',
      timestamp: at(2000),
      payload: { type: 'function_call', name: 'request_user_input', call_id: 'ask' },
    },
  ]);
  try {
    assert.equal((await o.language('ko')).locale, 'ko');
    const before = await o.service.refresh();
    const session = before.sessions[0];
    assert.ok(hangul.test(session.statusReason));
    const notices = before.notices!;
    const replies = notices.filter((n) => n.kind === 'reply');
    assert.equal(replies.length, 2);
    assert.ok(
      replies.every(
        (n) =>
          n.text.includes(ko.shared.redaction.hidden) || n.text.includes(ko.shared.redaction.token),
      ),
    );
    assert.ok(replies.some((n) => n.text.endsWith('…')));
    assert.ok(before.noticeStats!.unread > 0);
    o.service.store.noticeReceipt(notices, 'read');
    const read = await o.service.refresh();
    assert.equal(read.noticeStats?.unread, 0);

    const switched = await o.language('en');
    assert.equal(switched.locale, 'en');
    assert.ok(!hangul.test(switched.connectors.find((c) => c.provider === 'codex')!.message));
    const after = await o.service.refresh();
    // Nothing is re-parsed or re-ingested: same revision, ids, versions and receipts.
    assert.equal(after.sessions[0].revision, session.revision);
    assert.deepEqual(
      after.notices!.map((n) => [n.id, n.version, n.seenAt]),
      read.notices!.map((n) => [n.id, n.version, n.seenAt]),
    );
    assert.equal(after.noticeStats?.unread, 0);
    assert.equal(after.noticeStats?.total, read.noticeStats?.total);
    // ...and everything reads in English.
    assert.ok(!hangul.test(after.sessions[0].statusReason));
    assert.ok(!hangul.test(JSON.stringify(after.notices)));
    const shown = after.notices!.filter((n) => n.kind === 'reply').map((n) => n.text);
    assert.ok(shown.some((t) => t.includes('[hidden] hidden]')));
    assert.ok(shown.some((t) => t.includes('[token hidden]') && t.endsWith('…')));
    assert.equal(
      after.notices!.find((n) => n.kind === 'attention')?.text,
      en.shared.notice.attention,
    );
    const detail = o.service.store.get(session.id);
    assert.ok(!hangul.test(detail.events.map((e) => e.text).join('\n')));
    assert.equal(o.service.store.search('[hidden]')[0]?.session.id, session.id);

    const back = await o.language('ko');
    assert.equal(back.sessions[0].revision, session.revision);
    assert.deepEqual(
      back.notices!.map((n) => [n.id, n.version, n.seenAt]),
      read.notices!.map((n) => [n.id, n.version, n.seenAt]),
    );
    assert.ok(back.notices!.some((n) => n.text.includes(ko.shared.redaction.hidden)));
  } finally {
    await o.close();
  }
});

test('An excluded unknown workspace stays excluded in every language', async () => {
  const o = await office('office-exclude-');
  const id = '01a102c7-f8f8-71a0-82a0-cccc4defdf64';
  const sid = `codex:${id}`;
  await rollout(o.root, id, [
    { type: 'session_meta', timestamp: at(3000), payload: { id } },
    { type: 'event_msg', timestamp: at(2000), payload: { type: 'user_message', message: 'Hi' } },
  ]);
  const hidden = (s: Snapshot) => {
    assert.equal(s.sessions.length, 0);
    assert.equal(s.notices?.length, 0);
    assert.deepEqual(o.service.store.list(), []);
    assert.deepEqual(o.service.store.search('Hi'), []);
    assert.throws(() => o.service.store.get(sid));
  };
  try {
    const first = await o.service.refresh();
    assert.equal(first.locale, 'en');
    assert.equal(first.sessions[0].project, 'Unknown workspace');
    // Excluded in English: stored canonical, shown in the display language.
    const excluded = (await o.service.call('preferences', [
      { excludedProjects: ['Unknown workspace'] },
    ])) as Snapshot;
    assert.deepEqual(o.service.store.preferences().excludedProjects, [
      ko.server.session.unknownWorkspace,
    ]);
    assert.deepEqual(excluded.preferences.excludedProjects, ['Unknown workspace']);
    hidden(excluded);
    const korean = await o.language('ko');
    assert.equal(korean.locale, 'ko');
    assert.deepEqual(korean.preferences.excludedProjects, [ko.server.session.unknownWorkspace]);
    hidden(await o.service.refresh());

    // Excluded in Korean, then English.
    await o.service.call('preferences', [{ excludedProjects: [] }]);
    assert.equal(
      (await o.service.refresh()).sessions[0].project,
      ko.server.session.unknownWorkspace,
    );
    await o.service.call('preferences', [
      { excludedProjects: [ko.server.session.unknownWorkspace] },
    ]);
    const english = await o.language('auto');
    assert.equal(english.locale, 'en');
    hidden(english);

    // Rows saved by a build that stored the display name still match.
    o.service.store.db.prepare("UPDATE settings SET value=? WHERE key='preferences'").run(
      JSON.stringify({
        ...o.service.store.preferences(),
        excludedProjects: ['Unknown workspace'],
      }),
    );
    hidden(await o.language('ko'));
  } finally {
    await o.close();
  }
});

/**
 * Regression guard: user-visible copy lives in the catalogs. Hangul anywhere else in app code
 * means a string that skipped localization. Comments are fine; the allowlist stays tiny.
 */
test('No Korean copy outside the Korean catalog', () => {
  const root = path.join(import.meta.dirname, '..');
  const scanned: [dir: string, ext: RegExp][] = [
    ['src', /\.tsx?$/],
    ['server', /\.ts$/],
    ['desktop', /\.ts$/],
  ];
  const skip = [/^src\/shared\/i18n\/locales\/ko\//];
  // [file, line pattern]: language names are written in their own language.
  const allowed: [string, RegExp][] = [['src/shared/i18n/index.ts', /label: '한국어'/]];
  const hangul = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/;
  const offenders: string[] = [];
  for (const [dir, ext] of scanned)
    for (const entry of readdirSync(path.join(root, dir), { recursive: true }) as string[]) {
      const file = path.posix.join(dir, entry.split(path.sep).join('/'));
      if (!ext.test(file) || skip.some((r) => r.test(file))) continue;
      let block = false;
      readFileSync(path.join(root, file), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const code = line.trim();
          if (block) {
            block = !code.includes('*/');
            return;
          }
          if (code.startsWith('/*')) {
            block = !code.includes('*/');
            return;
          }
          if (code.startsWith('//') || code.startsWith('*')) return;
          const bare = code.replace(/\s\/\/\s.*$/, '');
          if (!hangul.test(bare)) return;
          if (allowed.some(([f, r]) => f === file && r.test(bare))) return;
          offenders.push(`${file}:${i + 1}: ${code.slice(0, 120)}`);
        });
    }
  assert.deepEqual(offenders, [], 'Move these strings into src/shared/i18n/locales');
});
