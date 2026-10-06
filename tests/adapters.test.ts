import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseRecords, redact, deriveState } from '../server/adapters/normalize.js';
import { readRecords } from '../server/adapters/files.js';
import { readOpenClawDatabases } from '../server/adapters/openclaw.js';
const now = Date.parse('2026-10-04T00:00:00Z');
const rec = (type: string, payload: any, offset = 0) => ({
  type,
  payload,
  timestamp: new Date(now + offset).toISOString(),
});
const opts = { provider: 'codex' as const, sourcePath: '/test/rollout.jsonl', mtime: now, now };
test('Forked Codex rollouts keep their own ID even with embedded parent metadata', () => {
  const parent = '01a102c7-f8f8-71a0-82a0-aaaa4defdf64';
  const child = '01a102ee-9111-7842-a1fa-48ee8abffe11';
  const s = parseRecords(
    [
      rec('session_meta', { id: child, cwd: '/tmp/child' }),
      rec('session_meta', { id: parent, cwd: '/tmp/parent' }, 1),
      rec('response_item', { type: 'function_call', name: 'review', call_id: 'own-call' }, 2),
    ],
    { ...opts, sourcePath: `/test/rollout-2026-10-04T03-02-31-${child}.jsonl`, now: now + 3 },
  );
  assert.equal(s.id, `codex:${child}`);
  assert.equal(s.cwd, '/tmp/child');
  assert.equal(s.status, 'work');
});
test('Codex IDs, workspace, model and cumulative usage are normalized without double counting', () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    cached_input_tokens: 50,
  };
  const s = parseRecords(
    [
      rec('session_meta', { id: 'one', cwd: '/tmp/project', git: { branch: 'main' } }),
      rec('turn_context', { model: 'model-x' }),
      rec('token_usage_record', { thread_token_usage: usage }),
      rec('token_usage_record', { thread_token_usage: usage }),
      rec('event_msg', {
        type: 'token_count',
        info: {
          total_token_usage: usage,
          last_token_usage: { input_tokens: 75 },
          model_context_window: 200,
        },
      }),
    ],
    opts,
  );
  assert.equal(s.id, 'codex:one');
  assert.equal(s.project, 'project');
  assert.equal(s.branch, 'main');
  assert.equal(s.model, 'model-x');
  assert.equal(s.usage.total, 120);
  assert.equal(s.usage.contextUsed, 75);
  assert.equal(s.usage.contextWindow, 200);
});
test('Out-of-order events are ordered and a completed turn is not an archived session', () => {
  const s = parseRecords(
    [
      rec('event_msg', { type: 'task_complete' }, 100),
      rec('event_msg', { type: 'task_started' }, 0),
    ],
    { ...opts, now: now + 150 },
  );
  assert.equal(s.status, 'done');
  assert.equal(s.archived, false);
  assert.equal(s.completed, false);
});
test('Old tool events become quiet, never implicitly terminated', () => {
  const s = parseRecords(
    [rec('response_item', { type: 'function_call', name: 'exec', call_id: 'a' })],
    { ...opts, now: now + 5 * 3600_000 },
  );
  assert.equal(s.status, 'sleep');
  assert.equal(s.statusEvidence, 'derived');
  assert.equal(s.archived, false);
});
test('Tool failure followed by recovery remains working', () => {
  const s = parseRecords(
    [
      rec(
        'response_item',
        { type: 'function_call_output', call_id: 'a', output: 'tests failed' },
        0,
      ),
      rec('response_item', { type: 'function_call', name: 'apply_patch', call_id: 'b' }, 10),
    ],
    { ...opts, now: now + 20 },
  );
  assert.equal(s.status, 'work');
});
test('Explicit input request becomes call; tool output clears it', () => {
  const call = rec('response_item', {
    type: 'function_call',
    name: 'request_user_input',
    call_id: 'a',
  });
  assert.equal(parseRecords([call], opts).status, 'call');
  assert.equal(
    parseRecords(
      [
        call,
        rec('response_item', { type: 'function_call_output', call_id: 'a', output: 'chosen' }, 5),
      ],
      opts,
    ).status,
    'work',
  );
});
test('Claude streaming messages use the largest usage snapshot per message', () => {
  const base = {
    type: 'assistant',
    sessionId: 'c1',
    timestamp: new Date(now).toISOString(),
    cwd: '/tmp/project',
  };
  const s = parseRecords(
    [
      {
        ...base,
        uuid: 'u1',
        message: {
          id: 'm1',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 },
        },
      },
      {
        ...base,
        uuid: 'u2',
        message: {
          id: 'm1',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello world' }],
          usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 5 },
          stop_reason: 'end_turn',
        },
      },
    ],
    { ...opts, provider: 'claude' },
  );
  assert.equal(s.id, 'claude:c1');
  assert.equal(s.usage.total, 19);
  assert.equal(s.usage.output, 4);
  assert.equal(s.status, 'done');
});
test('Unknown usage stays null and truncated Claude usage is explicitly sample scoped', () => {
  const s = parseRecords([{ type: 'user', message: { role: 'user', content: 'my request' } }], {
    ...opts,
    provider: 'claude',
  });
  assert.equal(s.usage.total, null);
  const p = parseRecords(
    [
      {
        type: 'assistant',
        message: {
          id: 'm',
          role: 'assistant',
          content: 'answer',
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      },
    ],
    { ...opts, provider: 'claude', partial: true },
  );
  assert.equal(p.usage.scope, 'sample');
});
test('OpenClaw JSONL v3 tool calls, ids, models, usage', () => {
  const s = parseRecords(
    [
      { type: 'session', id: 'claw1', version: 3, cwd: '/tmp/assistant', timestamp: now },
      {
        type: 'message',
        id: 'm1',
        timestamp: now + 10,
        message: {
          role: 'assistant',
          model: 'claw-model',
          content: [{ type: 'toolCall', id: 'tool1', name: 'read' }],
          usage: { input: 12, output: 3, cacheRead: 4, totalTokens: 19 },
        },
      },
    ],
    { ...opts, provider: 'openclaw', agentName: 'butler' },
  );
  assert.equal(s.id, 'openclaw:butler:claw1');
  assert.equal(s.model, 'claw-model');
  assert.equal(s.usage.total, 19);
  assert.equal(s.status, 'work');
});
test('Secrets are masked before storage, and tool arguments are not retained', () => {
  assert.ok(
    !redact('api_key="privatevalue" Bearer secretvalue sk-1234567890abcdefghijklmnop').includes(
      'privatevalue',
    ),
  );
  const s = parseRecords(
    [
      rec('response_item', {
        type: 'function_call',
        name: 'exec',
        arguments: JSON.stringify({ cmd: 'secret command' }),
        call_id: 'x',
      }),
    ],
    opts,
  );
  assert.ok(!JSON.stringify(s).includes('secret command'));
});
test('Malformed complete lines and unfinished tails never break collection', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-parser-'));
  try {
    const f = path.join(dir, 'a.jsonl');
    await writeFile(f, '{"type":"session","id":"ok"}\ninvalid\n{"partial":');
    const st = await stat(f);
    const r = await readRecords({ path: f, size: st.size, mtime: st.mtimeMs });
    assert.equal(r.records.length, 1);
    assert.equal(r.partial, true);
  } finally {
    await rm(dir, { recursive: true });
  }
});
test('Bounded reads keep head and recent records without malformed boundary joins', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-large-'));
  try {
    const f = path.join(dir, 'a.jsonl');
    const lines =
      Array.from({ length: 5000 }, (_, i) => JSON.stringify({ id: i, text: 'x'.repeat(200) })).join(
        '\n',
      ) + '\n';
    await writeFile(f, lines);
    const st = await stat(f);
    const r = await readRecords({ path: f, size: st.size, mtime: st.mtimeMs }, 900000);
    assert.equal(r.partial, true);
    assert.equal(r.records[0].id, 0);
    assert.equal(r.records.at(-1)!.id, 4999);
  } finally {
    await rm(dir, { recursive: true });
  }
});
test('OpenClaw SQLite reads only session tables, caches updates and namespaces agents', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-claw-'));
  try {
    const agent = path.join(dir, 'butler', 'agent');
    await mkdir(agent, { recursive: true });
    const db = new DatabaseSync(path.join(agent, 'openclaw-agent.sqlite'));
    db.exec(
      'CREATE TABLE session_nodes(current_session_id TEXT,entry_json TEXT,updated_at INTEGER,status TEXT,label TEXT,display_name TEXT,parent_session_key TEXT,archived_at INTEGER);CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT)',
    );
    db.prepare('INSERT INTO session_nodes VALUES (?,?,?,?,?,?,?,?)').run(
      's1',
      JSON.stringify({
        model: 'local',
        totalTokensFresh: true,
        totalTokens: 100,
        inputTokens: 80,
        outputTokens: 20,
      }),
      Date.now(),
      'done',
      'A local task',
      null,
      null,
      null,
    );
    db.prepare('INSERT INTO transcript_events VALUES (?,?,?)').run(
      's1',
      1,
      JSON.stringify({
        type: 'message',
        id: 'e1',
        timestamp: Date.now(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      }),
    );
    db.close();
    const cache = new Map();
    const r = await readOpenClawDatabases(dir, 10, cache);
    assert.equal(r.errors, 0);
    assert.equal(r.sessions[0].id, 'openclaw:butler:s1');
    assert.equal(r.sessions[0].usage.total, 100);
    assert.equal(r.sessions[0].title, 'A local task');
    const r2 = await readOpenClawDatabases(dir, 10, cache);
    assert.equal(r2.sessions[0], r.sessions[0]);
  } finally {
    await rm(dir, { recursive: true });
  }
});
test('OpenClaw isolates damaged metadata and invalidates rewritten transcripts at the same sequence', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-rewrite-'));
  try {
    const agent = path.join(dir, 'butler', 'agent');
    await mkdir(agent, { recursive: true });
    const db = new DatabaseSync(path.join(agent, 'openclaw-agent.sqlite'));
    db.exec(
      'CREATE TABLE session_nodes(current_session_id TEXT,entry_json TEXT,updated_at INTEGER,status TEXT,label TEXT,display_name TEXT,parent_session_key TEXT,archived_at INTEGER);CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT);CREATE TABLE transcript_rewrite_watermarks(session_id TEXT,generation TEXT,updated_at INTEGER)',
    );
    const n = db.prepare('INSERT INTO session_nodes VALUES (?,?,?,?,?,?,?,?)');
    n.run('bad', 'broken', 20, 'done', 'bad', null, null, null);
    n.run('good', '{}', 10, 'done', 'good', null, null, null);
    const event = (text: string) =>
      JSON.stringify({
        type: 'message',
        id: 'e1',
        timestamp: Date.now(),
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      });
    db.prepare('INSERT INTO transcript_events VALUES (?,?,?)').run(
      'good',
      1,
      event('before rewrite'),
    );
    db.prepare('INSERT INTO transcript_rewrite_watermarks VALUES (?,?,?)').run('good', 'first', 10);
    const cache = new Map();
    const one = await readOpenClawDatabases(dir, 10, cache);
    assert.equal(one.errors, 1);
    assert.equal(one.sessions.length, 1);
    assert.equal(one.sessions[0].events.at(-1)?.text, 'before rewrite');
    db.prepare('UPDATE transcript_events SET event_json=? WHERE session_id=?').run(
      event('after rewrite'),
      'good',
    );
    db.prepare('UPDATE transcript_rewrite_watermarks SET generation=? WHERE session_id=?').run(
      'second',
      'good',
    );
    const two = await readOpenClawDatabases(dir, 10, cache);
    assert.equal(two.sessions[0].events.at(-1)?.text, 'after rewrite');
    assert.notEqual(one.sessions[0].revision, two.sessions[0].revision);
    db.close();
  } finally {
    await rm(dir, { recursive: true });
  }
});
