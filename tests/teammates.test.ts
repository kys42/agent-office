import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanPrompt, cleanTitle, parseRecords } from '../server/adapters/normalize.js';
import { claudeTeammate } from '../server/adapters/identity.js';
import {
  claudeTeamLead,
  claudeTeammateLink,
  resetClaudeMetadataCache,
} from '../server/adapters/claude.js';
import { OfficeService } from '../server/service.js';
import { officeResidents } from '../src/shared/residents.js';
import { attachSessions } from '../src/shared/office.js';
import { buildOfficeModel } from '../src/shared/office-model.js';
import { demoSnapshot } from '../src/lib/demo.js';
import type { Session } from '../src/shared/types.js';

/*
 * Synthetic agent-team transcripts in the shape Claude Code 2.1.316 writes (read from its
 * bundle, never from a real ~/.claude): a pane teammate is its own session, every user/assistant
 * record carries `teamName` + `agentName`, its first turn is the lead's message in a
 * `<teammate-message>` envelope, and a session's own team is `session-<first 8 of lead id>`.
 */
const LEAD = 'a1b2c3d4-1111-4111-8111-111111111111';
const MATE = 'f0e1d2c3-2222-4222-8222-222222222222';
const TEAM = 'session-a1b2c3d4';
const now = Date.now();
const envelope = (
  text: string,
  attrs = 'teammate_id="team-lead" color="blue" summary="성능 조사"',
) => `<teammate-message ${attrs}>\n${text}\n</teammate-message>`;
function user(id: string, at: number, content: string, over: Record<string, unknown> = {}) {
  return {
    type: 'user',
    uuid: `u-${id}-${at}`,
    parentUuid: null,
    isSidechain: false,
    sessionId: id,
    cwd: '/tmp/office-demo',
    version: '2.1.316',
    timestamp: new Date(at).toISOString(),
    message: { role: 'user', content },
    ...over,
  };
}
function reply(id: string, at: number, text: string, over: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    uuid: `a-${id}-${at}`,
    isSidechain: false,
    sessionId: id,
    cwd: '/tmp/office-demo',
    timestamp: new Date(at).toISOString(),
    message: {
      id: `m-${id}-${at}`,
      role: 'assistant',
      model: 'claude-opus',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
    },
    ...over,
  };
}
const member = { teamName: TEAM, agentName: 'office-perf-scout' };
const mateRecords = (at = now) => [
  user(MATE, at - 4000, envelope('사무실 렌더링이 느린 원인을 찾아 줘'), member),
  reply(MATE, at - 3000, '원인을 찾았어요.', member),
];
const jsonl = (records: object[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const parse = (records: object[], sourcePath = `/tmp/projects/-tmp-office-demo/${MATE}.jsonl`) =>
  parseRecords(records as any[], { provider: 'claude', sourcePath, mtime: now, now });

test('A pane teammate is told apart by its records and titled by its member name, not the envelope', () => {
  const s = parse(mateRecords());
  assert.equal(s.title, 'office-perf-scout');
  assert.equal(s.nativeTitle, true);
  assert.equal(s.relation?.team, TEAM);
  // Not yet linked: the lead is found by the Claude adapter (claudeTeammateLink).
  assert.equal(s.relation?.kind, 'root');
  assert.equal(s.relation?.source, 'Claude agent team');
  const asked = s.events.find((e) => e.kind === 'user')!;
  assert.equal(asked.text, '사무실 렌더링이 느린 원인을 찾아 줘');
  assert.doesNotMatch(JSON.stringify(s.events), /teammate-message/);
});

test('A name the person gave wins over the member name; a generated title does not', () => {
  const named = parse([
    ...mateRecords(),
    { type: 'ai-title', aiTitle: '렌더링 조사', sessionId: MATE },
  ]);
  assert.equal(named.title, 'office-perf-scout');
  const renamed = parse([
    ...mateRecords(),
    { type: 'custom-title', customTitle: '성능 담당', sessionId: MATE },
  ]);
  assert.equal(renamed.title, '성능 담당');
});

test('The lead and plain sessions are no teammates', () => {
  // The lead's own records carry no team fields; a lead that names itself stays the lead.
  assert.equal(claudeTeammate([user(LEAD, now, '팀을 꾸려 줘')]), null);
  assert.equal(
    claudeTeammate([user(LEAD, now, '안녕', { teamName: TEAM, agentName: 'team-lead' })]),
    null,
  );
  // A session renamed with an `agent-name` record is not on a team.
  assert.equal(
    claudeTeammate([
      user(LEAD, now, '안녕'),
      { type: 'agent-name', agentName: 'reviewer', sessionId: LEAD },
    ]),
    null,
  );
  // Sidechain records (an in-process teammate under the lead's subagents/) are not its own team.
  assert.equal(claudeTeammate([user(LEAD, now, '안녕', { ...member, isSidechain: true })]), null);
  const lead = parse([user(LEAD, now, '팀을 꾸려 줘')], `/tmp/projects/x/${LEAD}.jsonl`);
  assert.equal(lead.relation?.team, undefined);
  assert.equal(lead.title, '팀을 꾸려 줘');
});

test('An in-process teammate (a sidechain under the lead) keeps its subagent link and a clean title', () => {
  const s = parse(
    [user(LEAD, now - 1000, envelope('테스트를 돌려 줘'), { isSidechain: true, agentId: 'a1' })],
    `/tmp/projects/x/${LEAD}/subagents/agent-a0123456789abcdef.jsonl`,
  );
  assert.equal(s.relation?.kind, 'subagent');
  assert.equal(s.relation?.parentNativeId, LEAD);
  assert.equal(s.title, '테스트를 돌려 줘');
});

test('Envelope markup never leaks, even cut off or with several messages', () => {
  assert.equal(
    cleanPrompt(`${envelope('첫째')}\n${envelope('둘째', 'teammate_id="scout"')}`),
    '첫째\n둘째',
  );
  // A stored title cut before the closing tag.
  assert.equal(cleanTitle('<teammate-message teammate_id="team-lead" summary="a">\n잘림'), '잘림');
  assert.equal(cleanTitle('<teammate-message teammate_id="team-lead">'), '');
});

async function claudeHome() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-teams-'));
  const root = path.join(temp, 'projects');
  const project = path.join(root, '-tmp-office-demo');
  await mkdir(project, { recursive: true });
  return { temp, root, project };
}

test('The lead is found from the team config, else from the team named after the lead', async () => {
  resetClaudeMetadataCache();
  const { temp, root, project } = await claudeHome();
  const mate = path.join(project, `${MATE}.jsonl`);
  try {
    await writeFile(mate, jsonl(mateRecords()));
    // No config, no lead transcript: nothing to link to.
    assert.equal(await claudeTeamLead(root, mate, TEAM, MATE), undefined);
    // The lead's transcript in the same project folder, found by the team's name.
    await writeFile(path.join(project, `${LEAD}.jsonl`), jsonl([user(LEAD, now, '팀')]));
    assert.equal(await claudeTeamLead(root, mate, TEAM, MATE), LEAD);
    // Two transcripts that both start so: not a guess.
    const twin = 'a1b2c3d4-3333-4333-8333-333333333333';
    await writeFile(path.join(project, `${twin}.jsonl`), jsonl([user(twin, now, '쌍둥이')]));
    assert.equal(await claudeTeamLead(root, mate, TEAM, MATE), undefined);
    // The team config names the lead outright, whatever the folders hold; a named team too.
    const named = 'Perf Crew';
    await mkdir(path.join(temp, 'teams', 'perf-crew'), { recursive: true });
    await writeFile(
      path.join(temp, 'teams', 'perf-crew', 'config.json'),
      JSON.stringify({ name: named, leadSessionId: LEAD, members: [] }),
    );
    assert.equal(await claudeTeamLead(root, mate, named, MATE), LEAD);
    assert.equal(await claudeTeamLead(root, mate, 'other-crew', MATE), undefined);
  } finally {
    resetClaudeMetadataCache();
    await rm(temp, { recursive: true, force: true });
  }
});

test('Linked, a teammate becomes its lead’s helper; without its lead it keeps a desk of its own', async () => {
  resetClaudeMetadataCache();
  const { temp, root, project } = await claudeHome();
  const mate = path.join(project, `${MATE}.jsonl`);
  try {
    await writeFile(mate, jsonl(mateRecords()));
    const parsed = parse(mateRecords(), mate);
    const alone = await claudeTeammateLink(parsed, root);
    assert.equal(alone.relation?.kind, 'root');
    assert.equal(alone.title, 'office-perf-scout');
    await writeFile(path.join(project, `${LEAD}.jsonl`), jsonl([user(LEAD, now, '팀')]));
    const linked = await claudeTeammateLink(parsed, root);
    assert.equal(linked.relation?.kind, 'subagent');
    assert.equal(linked.relation?.parentNativeId, LEAD);
    assert.equal(linked.parentId, LEAD);
    assert.notEqual(linked.revision, parsed.revision);
  } finally {
    resetClaudeMetadataCache();
    await rm(temp, { recursive: true, force: true });
  }
});

test('Collected, teammates sit at their lead’s desk; a teammate whose lead is gone stands alone', async () => {
  resetClaudeMetadataCache();
  const { temp, root, project } = await claudeHome();
  const service = new OfficeService(path.join(temp, 'data'), temp);
  service.roots.claude = root;
  service.live = {
    sessionsDir: path.join(temp, 'sessions'),
    alive: () => false,
    run: async () => '',
  };
  service.store.preferences({ enabledProviders: ['claude'] });
  const ORPHAN = 'c0ffee00-4444-4444-8444-444444444444';
  try {
    await writeFile(
      path.join(project, `${LEAD}.jsonl`),
      jsonl([
        user(LEAD, now - 9000, '팀을 꾸려서 성능을 봐 줘'),
        reply(LEAD, now - 8000, '맡겼어요.'),
      ]),
    );
    await writeFile(path.join(project, `${MATE}.jsonl`), jsonl(mateRecords()));
    await writeFile(
      path.join(project, `${ORPHAN}.jsonl`),
      jsonl([
        user(ORPHAN, now - 2000, envelope('문서를 정리해 줘'), {
          teamName: 'session-deadbeef',
          agentName: 'doc-keeper',
        }),
      ]),
    );
    const snapshot = await service.refresh();
    const byNative = (id: string) => snapshot.sessions.find((s) => s.nativeId === id)!;
    const mateSession = byNative(MATE);
    const orphan = byNative(ORPHAN);
    assert.equal(mateSession.title, 'office-perf-scout');
    assert.equal(mateSession.relation?.kind, 'subagent');
    assert.equal(mateSession.relation?.parentNativeId, LEAD);
    assert.equal(orphan.title, 'doc-keeper');
    assert.equal(orphan.relation?.kind, 'root');
    assert.equal(orphan.relation?.team, 'session-deadbeef');
    for (const s of snapshot.sessions) assert.doesNotMatch(s.title, /teammate-message/);
    // The office seats the linked teammate beside its lead, the orphan at its own desk.
    const { sessions: residents } = officeResidents(snapshot.sessions, now);
    const seated = attachSessions(residents);
    const lead = byNative(LEAD);
    assert.equal(seated.find((s) => s.nativeId === MATE)?.attachedTo, lead.id);
    assert.equal(seated.find((s) => s.nativeId === ORPHAN)?.attachedTo, undefined);
  } finally {
    service.stop();
    resetClaudeMetadataCache();
    await rm(temp, { recursive: true, force: true });
  }
});

test('The office model groups teammates under the lead and carries their news there', () => {
  const base = demoSnapshot().sessions[0];
  const make = (id: string, patch: Partial<Session> = {}): Session => ({
    ...base,
    id,
    nativeId: id,
    provider: 'claude',
    status: 'idle',
    updatedAt: now - 60_000,
    events: [],
    activity: undefined,
    runtime: undefined,
    taskStartedAt: undefined,
    resident: undefined,
    actor: undefined,
    attachedTo: undefined,
    archived: false,
    pinned: false,
    zone: 'office',
    relation: { kind: 'root', parentNativeId: null, source: 'fixture' },
    ...patch,
  });
  const teammate = (id: string, title: string, lead: string | null): Session =>
    make(id, {
      title,
      officeSeat: undefined,
      status: 'work',
      updatedAt: now - 1000,
      parentId: lead,
      relation: {
        kind: lead ? 'subagent' : 'root',
        parentNativeId: lead,
        source: 'Claude agent team',
        team: TEAM,
      },
    });
  const sessions = [
    make('claude:lead', { nativeId: LEAD, officeSeat: 0, title: '리드' }),
    teammate('claude:mate-1', 'office-perf-scout', LEAD),
    teammate('claude:mate-2', 'doc-keeper', LEAD),
    teammate('claude:orphan', 'lonely-scout', null),
  ];
  const at = now - 500;
  const model = buildOfficeModel(
    {
      ...demoSnapshot(),
      sessions,
      notices: [
        {
          id: 'mate-call',
          sessionId: 'claude:mate-1',
          eventId: 'e',
          kind: 'attention',
          text: '확인해 주세요',
          at,
          receivedAt: at,
          version: 'v',
          seenAt: null,
          viewedAt: null,
          dismissedAt: null,
          resolvedAt: null,
          bootstrap: false,
          background: true,
        },
      ],
    },
    now,
  );
  const lead = model.seats.find((v) => v.session.id === 'claude:lead')!;
  assert.deepEqual(lead.helpers.map((v) => v.session.id).sort(), [
    'claude:mate-1',
    'claude:mate-2',
  ]);
  assert.equal(lead.helperUnread.length, 1, 'a teammate’s request shows as the lead’s helper news');
  assert.deepEqual(
    model.seats.map((v) => v.session.id).sort(),
    ['claude:lead', 'claude:orphan'],
    'only the teammate without its lead has a desk of its own',
  );
});
