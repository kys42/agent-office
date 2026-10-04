import type { Session, Snapshot, Mood, Provider } from '../shared/types';
import { noticeCandidates } from '../shared/notices';
import { runtimeObservation } from '../shared/presentation';
import { allocateSeats, officeZone, attachSessions } from '../shared/office';
export function reconcileDemo(snapshot: Snapshot): Snapshot {
  const sessions = snapshot.sessions.map((s) => ({
    ...s,
    zone: officeZone(s, snapshot.preferences),
  }));
  const active = sessions.filter((s) => s.zone === 'office');
  const previous = Object.fromEntries(
    active.filter((s) => s.officeSeat !== undefined).map((s) => [s.id, s.officeSeat!]),
  );
  const seats = allocateSeats(active, previous);
  return {
    ...snapshot,
    sessions: attachSessions(sessions.map((s) => ({ ...s, officeSeat: seats[s.id] }))),
  };
}
const defs: [string, Provider, string, string, Mood, string][] = [
  [
    '코코',
    'claude',
    '사무실에 새 동료 맞이하기',
    'agent-office',
    'work',
    '세션 수집기를 연결하고 있어요',
  ],
  ['네모', 'codex', '검색 결과를 더 빠르게', 'agent-office', 'think', '검색 흐름을 살펴보는 중'],
  ['집사', 'openclaw', '오늘의 업무 브리핑', 'daily-brief', 'work', '오늘의 기록을 모으고 있어요'],
  ['당근', 'claude', '9월의 작업 회고', 'my-notes', 'call', '회고의 제목을 골라 주세요'],
  ['삑삑', 'codex', '로그인 재시도 오류 수정', 'api-server', 'work', '회귀 테스트 실행 중'],
  ['모모', 'claude', '컴포넌트 정리', 'design-system', 'done', '이번 응답을 마쳤어요!'],
  ['큐브', 'codex', '작은 버그를 잡는 시간', 'web-app', 'sleep', '잠깐 쉬고 있어요'],
  ['꽃게', 'openclaw', '주간 일정 정리', 'assistant', 'idle', '다음 이야기를 기다려요'],
];
export function demoSnapshot(): Snapshot {
  const now = Date.now();
  const snapshot: Snapshot = {
    version: 1,
    syncing: false,
    error: null,
    lastSync: now,
    preferences: {
      paused: false,
      privacy: false,
      reducedMotion: false,
      excludedProjects: [],
      enabledProviders: ['claude', 'codex', 'openclaw'],
      maxSessions: 120,
      standbyHours: 4,
      archiveDays: 7,
      bubbleHours: 3,
    },
    connectors: (['claude', 'codex', 'openclaw'] as Provider[]).map((provider) => ({
      provider,
      state: 'connected',
      path: '데모 데이터',
      count: defs.filter((d) => d[1] === provider).length,
      lastSync: now,
      message: '예시 세션 · 실제 작업과 분리',
    })),
    sessions: defs.map(([alias, provider, title, project, status, action], i) => ({
      id: `demo:${i}`,
      nativeId: `demo-${i}`,
      protocolVersion: 1,
      runtime: runtimeObservation(status, now - i * 10_000, '데모의 공개 작업 상태'),
      relation: { kind: 'root', parentNativeId: null, source: 'demo' },
      provider,
      title,
      alias,
      project,
      status,
      action,
      cwd: `~/Projects/${project}`,
      branch: 'feat/tiny-office',
      model:
        provider === 'claude'
          ? 'Claude Opus'
          : provider === 'codex'
            ? 'GPT Codex'
            : 'OpenClaw Agent',
      startedAt: now - 60 * 60_000,
      updatedAt: i === 6 ? now - 5 * 3600_000 : i === 7 ? now - 9 * 86400_000 : now - i * 10_000,
      officeSeat: i < 6 ? i : undefined,
      zone: i < 6 ? 'office' : i === 6 ? 'waiting' : 'archive',
      openCount: [12, 8, 3, 6, 2, 1, 4, 0][i],
      observedAt: now,
      statusEvidence: 'observed',
      statusReason: '인터랙티브 데모 · 예시 상태',
      sourcePath: 'demo',
      sourceKind: 'demo',
      sourceVersion: '1',
      partial: false,
      archived: false,
      pinned: false,
      parentId: null,
      usage: {
        input: 12400 + i * 1200,
        output: 2300 + i * 200,
        cached: 8400,
        total: 14700 + i * 1400,
        contextUsed: 12400,
        contextWindow: 200000,
        scope: 'session',
        source: '데모 예시',
      },
      events: [
        {
          id: `e-${i}-1`,
          at: now - 100000,
          kind: 'user',
          text:
            title +
            ' 작업을 이어서 진행해 주세요. 이전에 정한 방향을 유지하면서 실제 사용하는 흐름까지 확인하면 좋겠습니다.',
          sourceRef: 'demo',
        },
        {
          id: `e-${i}-2`,
          at: now - 30000,
          kind: 'assistant',
          phase: i === 5 ? 'final' : 'commentary',
          text:
            action +
            '\n\n지금까지 확인한 내용을 정리했습니다. 같은 프로젝트의 동료가 가까이 앉고, 새 기록을 받아도 자리를 지키도록 연결했습니다.\n\n' +
            '다음으로 실제 사용 중 맥락이 끊기는 부분을 확인하고 있습니다. 최근 대화를 먼저 보여주고 긴 내용은 필요한 순간에 펼쳐 볼 수 있도록 정리했습니다. '.repeat(
              5,
            ),
          sourceRef: 'demo',
        },
      ],
      artifacts:
        i === 0
          ? [
              'https://github.com/example/agent-office/pull/42',
              'https://github.com/example/agent-office/issues/18',
            ]
          : [],
      notes: '',
      revision: 'demo',
      completed: false,
    })),
  };
  snapshot.notices = snapshot.sessions
    .filter((s) => s.zone === 'office')
    .flatMap((s) => noticeCandidates(s, now, true).slice(-1))
    .sort((a, b) => b.at - a.at);
  return snapshot;
}
