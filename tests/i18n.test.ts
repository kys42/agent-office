import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getLocale,
  messagesFor,
  resolveLocale,
  setLocale,
  type Locale,
} from '../src/shared/i18n/index.js';
import { MOODS, PROVIDERS } from '../src/shared/types.js';
import { summarizeActivity } from '../src/shared/activity.js';
import { NOTICE_LABELS, noticeCandidates } from '../src/shared/notices.js';
import { TRIAGE_LABELS, durationShort } from '../src/shared/triage.js';
import { officeSchedule } from '../src/shared/lifecycle.js';
import { deriveState } from '../src/shared/runtime.js';
import { FOCUS_LABELS, POSTURE_LABELS } from '../src/shared/presentation.js';
import { TONE_LABELS } from '../src/shared/speech.js';
import { PET_LABELS, residentLabel } from '../src/shared/office-model.js';
import { cleanInput } from '../desktop/terminals.js';
import { parseRecords, redact } from '../server/adapters/normalize.js';
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

test('Notice versions and event ids do not depend on the display language', () => {
  const records = [
    {
      type: 'event_msg',
      timestamp: new Date(now - 2000).toISOString(),
      payload: {
        type: 'agent_message',
        message: 'Deploy with api_key=abcdef123456 now',
        phase: 'final',
      },
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
  const en = parse('en');
  const ko = parse('ko');
  setLocale('en');
  assert.deepEqual(
    en.s.events.map((e) => e.id),
    ko.s.events.map((e) => e.id),
  );
  assert.notEqual(en.s.statusReason, ko.s.statusReason);
  assert.deepEqual(
    en.notices.map((n) => [n.id, n.kind, n.version]),
    ko.notices.map((n) => [n.id, n.kind, n.version]),
  );
  assert.ok(en.notices.some((n) => n.kind === 'attention'));
  assert.notEqual(en.notices.at(-1)!.text, ko.notices.at(-1)!.text);
  assert.match(redact('password=hunter2'), /\[숨김\]|\[hidden\]/);
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
    assert.ok(!hangul.test(markdown));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Switching language re-writes collected text without new or duplicate notices', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-switch-'));
  const root = path.join(temp, 'sessions');
  await mkdir(root);
  const id = '01a102c7-f8f8-71a0-82a0-bbbb4defdf64';
  const at = (offset: number) => new Date(now - offset).toISOString();
  await writeFile(
    path.join(root, `rollout-${id}.jsonl`),
    [
      { type: 'session_meta', timestamp: at(5000), payload: { id } },
      { type: 'event_msg', timestamp: at(4000), payload: { type: 'user_message', message: 'Hi' } },
      {
        type: 'event_msg',
        timestamp: at(3000),
        payload: { type: 'agent_message', message: 'Done with token=abc123', phase: 'final' },
      },
      {
        type: 'response_item',
        timestamp: at(2000),
        payload: { type: 'function_call', name: 'request_user_input', call_id: 'ask' },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n') + '\n',
  );
  const service = new OfficeService(path.join(temp, 'data'), temp);
  service.roots.codex = root;
  service.store.preferences({ enabledProviders: ['codex'] });
  try {
    assert.equal(getLocale(), 'en');
    const before = await service.refresh();
    const session = before.sessions[0];
    assert.ok(!hangul.test(session.statusReason));
    assert.ok(!hangul.test(before.connectors.find((c) => c.provider === 'codex')!.message));
    const notices = before.notices!;
    assert.ok(notices.length > 0);
    service.store.noticeReceipt(notices, 'read');
    const switched = (await service.call('preferences', [{ locale: 'ko' }])) as typeof before;
    assert.equal(getLocale(), 'ko');
    assert.ok(hangul.test(switched.connectors.find((c) => c.provider === 'codex')!.message));
    const after = await service.refresh();
    assert.notEqual(after.sessions[0].revision, session.revision);
    assert.ok(hangul.test(after.sessions[0].statusReason));
    assert.deepEqual(
      after.notices!.map((n) => [n.id, n.version]),
      notices.map((n) => [n.id, n.version]),
    );
    assert.equal(after.noticeStats?.unread, 0);
    const attention = after.notices!.find((n) => n.kind === 'attention');
    assert.ok(attention && hangul.test(attention.text));
  } finally {
    service.stop();
    setLocale('en');
    await rm(temp, { recursive: true, force: true });
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
  const skip = [
    /^src\/shared\/i18n\/locales\/ko\//,
    // Pending deletion: replaced by the desk dock.
    /^src\/components\/MiniOffice\.tsx$/,
  ];
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
