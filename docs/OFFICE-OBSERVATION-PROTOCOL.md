# Office Observation Protocol v1 — 구현 정책

2026-10-04 · [골든 제품 정책](GOLDEN-OFFICE-POLICY.md)의 구현 정본. 공급자를 더 붙여도 사무실의 의미와 사용자 확인 상태가 달라지지 않게 하는 중간 규격이다.

## 경계와 소유권

| 계층 | 책임 | 구현 |
| --- | --- | --- |
| Source adapter | 파일/DB 읽기, 원본 ID, 공개 메시지, 원본 상태·관계 해석 | `server/adapters/*` |
| Normalized observation | 공급자에 무관한 Session, RuntimeObservation, OfficeEvent, SessionRelation, WorkspaceIdentity | `src/shared/types.ts`, `src/shared/runtime.ts` |
| Reconciliation | 여러 transport 파일을 한 대화로 병합, Git 저장소 위치 확인 | `server/adapters/merge.ts`, `server/workspaces.ts` |
| Office policy | 대기/보관, 좌석 소유권, 프로젝트·브랜치 구역, 소식과 확인 상태 | `src/shared/office.ts`, `src/shared/notices.ts`, `server/store.ts` |
| Presentation | 실제 근거와 장식 행동을 구분해 그림과 문장으로 표시 | `src/shared/presentation.ts`, React components |

새 provider의 파일명, DB 컬럼, tool 이름을 Office/Inspector에 분기문으로 넣지 않는다. adapter에서 기존 의미로 번역한다. 같은 도구 의미를 가진 새 이름은 어댑터에서 정규화하거나 공통 활동 라벨 맵으로 등록한다. 원문 내부 분석은 이 경계를 넘지 않는다.

## 계약의 핵심

```ts
Session {
  protocolVersion: 1
  id: string                 // provider:[agent namespace:]native conversation ID
  nativeId: string           // 로그 파일 UUID와 별개
  provider: Provider
  title: string              // 원본 표시 이름 또는 명시된 fallback
  nativeTitle: boolean
  cwd: string | null         // 기록의 작업 위치
  branch: string | null      // 기록의 브랜치
  gitCommit?: string | null // 기록의 커밋
  workspace?: WorkspaceIdentity
  relation?: SessionRelation
  runtime?: RuntimeObservation
  events: OfficeEvent[]
  partial: boolean           // 원본 일부만 읽은 경우
  updatedAt: number          // 원본 활동의 시각
  observedAt: number         // 수집기가 관측한 시각
}
```

이 문서는 주요 필드의 의미를 설명한다. 실제 TypeScript 필드는 `types.ts`가 정본이다. 추가 필드와 optional 여부는 거기서 확인한다. 기존 저장 레코드를 읽을 수 있도록 v1의 새 필드는 optional이며 구형 필드에서 보수적으로 변환한다.

- **정체성**: provider와 agent 네임스페이스가 다르면 같은 nativeId라도 다른 동료. transport 조각이 추가되어도 동료를 새로 만들지 않는다.
- **시각**: epoch milliseconds. 소식 receivedAt은 원본 at과 별개. 미래/없는 시각은 어댑터 fallback으로 처리하며 파일 mtime을 진짜 실행 heartbeat라고 부르지 않는다.
- **미관측**: null/unknown. 0 토큰, 기본 main 브랜치, 부모 없음의 확정 증거로 채우지 않는다. root는 현재 관측된 부모 관계가 없다는 뜻이다.
- **안정 이벤트 ID**: 원본 message/UUID/call ID를 우선한다. 없을 때 시간·종류·내용 hash. 후자는 원본이 스트리밍 ID를 제공하지 않으면 같은 메시지 업데이트를 완벽히 식별할 수 없다.
- **이벤트 역할**: user=사람의 요청, assistant=공개 설명/답변, tool=호출 사실, result=도구 반환, lifecycle=명시된 턴 시작/응답 완료/중단. tool/result는 기본 소식으로 승격하지 않는다.
- **도구 의미**: `intent=request-input|tool-use`. 어댑터가 AskUserQuestion/request_user_input 같은 원본 이름을 번역한다. 소식·확인 정책은 원본 도구명 정규식 대신 intent를 읽는다.
- **공개 단계**: commentary와 final을 구분. final도 업무 전체 성공의 보증이 아니다. analysis/reasoning은 저장·대화·소식 후보에서 제외한다.
- **관련 결과물**: 링크가 대화에 나타났다는 사실만 보장. PR을 실제로 만들었는지/머지했는지는 별도 근거가 필요하다.

## 실행 관측과 사무실 상태

`runtime.phase`는 working, thinking, needs-input, responded, interrupted, error, quiet, unknown 중 하나다. `at/evidence/reason`을 항상 함께 다룬다. `status`는 기존 캐릭터와 호환하는 표시 값이며, `zone`은 사무실/대기/보관 위치다. 어느 것도 다른 축을 덮어쓰지 않는다.

예: 마지막 관측이 `working`이지만 5분간 새 기록이 없으면 runtime은 working으로 보존한다. 사무실 표시만 idle, 장식 동작은 resting/strolling/dozing이 된다. “프로세스가 종료됐다”, “성공했다”는 결론을 만들지 않는다. 중단 이벤트는 runtime의 interrupted로 남는다. 오래된 needs-input의 소식 확인과 원래 앱에서 실제 답변하는 동작도 별개다.

기본 시간 정책은 `deriveState`/`officeZone`에서만 바꾼다. 공급자별로 Codex는 2분, Claude는 30초처럼 임의의 다른 휴식 규칙을 넣지 않는다. paused/missing/error는 Connector의 수집 상태이며 개별 동료의 실패를 뜻하지 않는다.

## 현재 어댑터의 실제 근거

| 정보 | Claude Code | Codex | OpenClaw |
| --- | --- | --- | --- |
| 정체성 | JSONL sessionId; subagent는 agentId+subagents 경로 | session_meta 대화 ID; continuation 병합 | agent namespace + current_session_id/JSONL ID |
| 이름 | custom-title, optional session index | threads.name / session index / 정제된 title | session_nodes label/display_name 또는 공개 요청 |
| 진행 설명 | 공개 assistant text | 공개 commentary/final message 및 event | 공개 assistant text |
| 상태 | 사용자·도구·stop_reason | task_started/complete/aborted, 도구·입력 요청 | transcript와 session_nodes status |
| 부모 | subagents 경로; parentUuid는 메시지 포인터 | 명시적 subagent/parent/fork 메타데이터 | parent_session_key를 해당 agent의 ID로 해석 |
| 브랜치 | gitBranch | session_meta.git.branch 및 metadata | 기록에 없는 경우 null 유지 |
| 사용량 | message usage, streaming message ID 중복 방지 | cumulative token record, 문맥 한도 별도 | fresh session total 또는 수집한 message sample |

일부 원본 버전이나 세션에는 필드가 없을 수 있다. 표는 현재 어댑터가 읽는 근거이지 모든 세션에서 값이 있다는 보증이 아니다. 출처 확실성이 없는 새 상태 이름은 unknown으로 남기고 fixture를 확보한 뒤 추가한다.

## 영속성과 갱신

- sessions: 원본 관측 캐시. personal: 별명·메모·핀·사용자 보관·열람 빈도. settings.office_seats: 안정적인 배치 순서 토큰. 원본 재수집은 personal을 덮어쓰지 않는다.
- notices: 공개 소식과 seenAt/dismissedAt/resolvedAt. notice_observed: 초기화 때 건너뛴 과거 이벤트도 기억해서 다음 폴링이 새 소식으로 재생하지 않게 한다. notice_cursors: 최초 연결 여부와 관측 기준.
- 첫 연결은 최근 3시간의 마지막 공개 소식 한 건으로 시작한다. 그 뒤 처음 발견된 메시지는 timestamp가 조금 늦게 전달되어도 놓치지 않는다. 동일 이벤트 내용이 바뀌면 새 version이 되고 미확인으로 돌아온다.
- 확인 요청은 `{id, version}` 목록과 read/dismiss/unread 행위로 보낸다. 서버는 정확히 같은 버전만 변경한다. 읽음 버튼을 누르는 동안 도착한 새로운 문장을 읽음 처리하지 않는다.
- seenAt은 원문 작업 완료와 다르며 dismissedAt은 읽음과 다르다. 진행 소식이 업데이트될 때 이전 내용의 접기 상태를 새 내용에 무조건 전파하지 않는다.
- 전체 미확인 소식을 유지하고 최근 읽은 소식은 30일간 목록에서 조회한다. 원본이 수집 범위에서 빠지거나 제외되면 목록에서도 숨기되 사용자의 확인 상태를 지우지 않는다.
- 수집 오류는 마지막 정상 기록을 보존한다. 원본 파일·DB는 항상 읽기 전용이다.

## 새 공급자 추가 절차

1. 실제 원본 fixture 확보: 일반 대화, 공개 진행, 도구 결과, 종료·입력 요청, 이름 변경, 부분 파일, 가능하면 부모/분기 관계.
2. stable conversation ID와 transport ID를 구분하고 namespace를 정한다. 파일명만으로 사람의 대화를 복제하지 않는다.
3. 원본을 이 공통 계약으로 변환한다. 지원하지 않는 상태·사용량·관계는 만들어 넣지 않는다.
4. 같은 normalized observation이 기존 공급자와 같은 seat/notice/presentation 결과를 내는 계약 테스트를 통과시킨다.
5. reload/collector 재시작, malformed tail, stream update, duplicate transport, 개인정보 모드까지 확인한다.
6. 공급자 고유 UI가 필요하면 먼저 규격에 공통 의미가 필요한지 검토한다. 캐릭터/출처 색 외의 공급자 전용 상태는 예외 문서가 필요하다.

새 동작 후보는 [골든 문서 9절](GOLDEN-OFFICE-POLICY.md#9-쓸-만한-후속-후보)에 유지한다. 사용자에게 보이는 의미를 정하지 않은 채 시각 효과부터 추가하지 않는다.


## 수집 식별 보강 (v1 호환 선택 필드)

- `Session.identity.evidence`: database / native-header / subagent-path / filename-fallback. `transportId`는 파일의 식별자이며 canonical ID를 대체하지 않는다.
- `Session.sourcePaths`: 정확히 같은 native conversation으로 합친 원본 경로들. `sourcePath`는 가장 최근 관측의 대표 경로.
- `OfficeEvent.legacyId`: 수집기 업그레이드 전 ordinal key를 가진 소식의 receipt 이관용. 내용/시각 버전이 정확히 같은 경우만 재사용하며 grouping/표시에는 사용하지 않는다.
- 새 어댑터도 native identity → provider/agent namespace → 공통 merge 순서를 따른다. native 관계 없이 같은 cwd/제목/branch인 세션을 합치면 규격 위반이다.

## 현재 작업 위치의 Git 관측

`WorkspaceIdentity.git = { branch: string|null, commit: string|null, state: branch|detached|unborn|unavailable, observedAt: number }`는 공급자와 독립적인 읽기 전용 현재 관측이다. 원본 branch/gitCommit과 합쳐 저장하지 않는다. UI 공통 `branchInfo`와 `benchKey`가 표시·공동 책상 판단을 맡으며, 불명확한 브랜치를 main으로 대체하지 않는다. 같은 커밋의 서로 다른 worktree는 같은 프로젝트이지만 별도의 책상이다. 동적 가구 배치 계약은 GOLDEN-OFFICE-POLICY v2를 따른다.

## 대화 종류와 중요 소식 — 2026-10-05

`OfficeEvent.phase`는 commentary/final/undefined다. 공통 `conversationKind`가 user→request, assistant+commentary→progress, assistant+final→reply, 단계 없는 assistant→message, 그 외→work로 분류한다. `message`는 최종 응답의 별칭이 아니다. 공급자 원본 completion/tool-use 증거는 어댑터가 phase로 변환한다.

`OfficeNotice.phase`는 해당 공개 메시지의 근거를 보존한다. 새 notice kind `message`는 단계 없는 공개 응답이다. 기존 phase 없는 reply도 기본 소식함에서는 미검증 메시지다. `isFinalNotice`, `isAttentionNotice`, `isInboxNotice`, `unreadNoticeCount`가 모든 표시 표면과 noticeStats.unread의 공통 정책이다. noticeStats.total과 snapshot.notices에는 전체 기록이 남는다. 폴링과 분류 보완은 읽음/접기를 초기화하지 않고 새 내용·새 최종 버전만 다시 미확인으로 만든다.

대화의 현재 원본 수집 구간에서 빠진 공개 메시지는 해당 세션의 저장된 소식으로 보완할 수 있다. 이때 `OfficeEvent.excerpt=true`로 표시하고 화면에 **보관된 발췌 · 원문 일부**를 명시한다. 원본 이벤트가 있으면 항상 원본을 우선하며 이벤트 ID 또는 같은 종류/phase/본문·시각으로 중복을 막는다. 공개 발췌는 원문 전체인 것처럼 표현하지 않는다. 최종 응답 필터를 선택하면 마지막 해당 응답의 시작 부분으로 이동한다.
