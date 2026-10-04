# 세션 기록 분석과 수집 모듈

기준: 2026-10-05. 실제 import와 구현을 기준으로 **직접 사용하는 외부 모듈 / 정책을 이식한 코드 / 자체 구현 / 조사만 한 후보**를 구분한다. 외부 전체 앱을 가져와 실행하는 구조가 아니다.

## 처리 흐름

```text
OfficeService (5초 폴링, 읽기 범위·오류 격리)
  ├─ JSONL 탐색 → readRecords → Orca byte reader
  │                            → resolveIdentity + parseRecords
  ├─ Codex/Claude index·DB·sidecar → 이름·작업 위치 보완
  └─ OpenClaw read-only SQLite → resolveIdentity + parseRecords + DB 상태
        ↓
  mergeSessions (동일 canonical ID의 조각만 병합)
        ↓
  enrichWorkspaces (Git common-dir/worktree/현재 Git 관측)
        ↓
  OfficeStore (원본 캐시 / 사용자 설정 / 소식과 receipt 분리)
        ↓
  공통 관측·제품 정책 → 사무실 / 상세 / 검색 / 인수인계 / 읽기 MCP
```

형식·관계 근거를 해석하는 경계는 어댑터이고, 어떤 정보를 책상이나 소식함에 표시할지는 공통 제품 정책이다. 같은 입력이 공급자 이름만 다르다는 이유로 다른 사용자 경험을 만들지 않는다.

## 모듈 출처와 실제 실행 경계

| 책임 | 실행 코드 | 출처와 수정 범위 |
| --- | --- | --- |
| JSONL 바이트/줄 경계, 불완전 꼬리, 레코드 예산 | [Orca runtime](../../vendor/orca/runtime/session-scanner-jsonl-reader.ts), `session-transcript-record-budget.ts` | **외부 모듈 직접 사용.** MIT, Orca `ea6a6d60774ac2b74bb6692d1798e3ab13b99ae0`. 바이트 fold 유지, 원본 WSL opener를 주입 가능한 stream으로 교체 |
| Codex non-user source/부모·역할 해석 | [Orca origin classifier](../../vendor/orca/runtime/session-scanner-codex-non-user-origin.ts) | **외부 모듈 직접 사용.** 같은 고정 커밋. 로컬 value helper import만 조정 |
| 탐색 범위, head/tail 선택, fd 소유·닫기, 큰 첫 metadata 복구 | [files.ts](../../server/adapters/files.ts) | **자체 통합 코드.** 위 외부 reader에 bounded async byte generator를 주입 |
| Claude 중첩 subagent 경로, sidecar, 제목 우선순위 | [identity.ts](../../server/adapters/identity.ts), [claude.ts](../../server/adapters/claude.ts), [normalize.ts](../../server/adapters/normalize.ts) | **정책의 TypeScript 이식.** Agent Sessions `b7893c772b0014918211f1c45a5ab58add229703`, MIT. Swift 앱/파서 전체를 실행하지 않음 |
| 공급자별 canonical ID 결정, continuation 정확 병합 | [identity.ts](../../server/adapters/identity.ts), [merge.ts](../../server/adapters/merge.ts) | **자체 구현.** 내부 ID와 파일 ID 분리 원칙은 비교 조사, Codex origin 해석은 위 외부 함수 호출 |
| 공개 이벤트·phase·usage 정규화 | [normalize.ts](../../server/adapters/normalize.ts) | **자체 구현.** Claude 제목 정책 이식 부분은 위 출처에 해당 |
| Codex 표시 이름/작업 위치 metadata | [codex.ts](../../server/adapters/codex.ts) | **자체 구현.** JSONL index와 read-only threads DB |
| OpenClaw SQLite·rewrite watermark·namespace | [openclaw.ts](../../server/adapters/openclaw.ts) | **자체 구현.** 로컬 `session_nodes` / `transcript_events` 형식 지원 |
| 관측·활동·공간·대화·소식 정책 | [shared](../../src/shared), [store.ts](../../server/store.ts), [workspaces.ts](../../server/workspaces.ts) | **자체 구현.** 외부 수집기가 UI 좌석이나 읽음 정책을 결정하지 않음 |
| 4방향 BFS 경로 탐색 | [pathfinding.ts](../../src/lib/pathfinding.ts) | **Pixel Agents 이식.** `3537e14`, MIT. 현재 메인 좌석 이동에는 사용하지 않는 확장용 코드 |

Orca 원본, 파일별 checksum, 수정 설명은 [manifest](../../vendor/orca/manifest.json)에 있다. Agent Sessions 원본과 이식 위치는 [vendor README](../../vendor/agent-sessions/README.md)에 있다. 원본 보존용 `upstream/`은 실행 코드가 아니다. `.research/`는 비교용 clone이며 Git·빌드에서 제외한다. 런타임 의존성의 정확한 버전은 `package-lock.json`을 따른다.

Claude-Mem, AgentPet은 비교 조사만 했고 현재 수집 런타임에 포함하지 않았다. CASS와 MCP Agent Mail은 소개·라이선스 확인 범위이며 상세 파서 분석/코드 도입을 주장하지 않는다. 전체 파서를 가져오지 않은 이유와 각 비교 파일은 [레퍼런스 감사](../research/INGESTION-REFERENCE-AUDIT.md)를 따른다.

## 세 종류의 ID

| ID | 의미 | 사용처 |
| --- | --- | --- |
| native/canonical session ID | 공급자가 정한 대화 정체성에 provider/agent namespace를 더한 값 | 세션 병합, 개인 메모·좌석 연결 |
| transport ID / source path | 해당 로그 파일·전송 조각의 식별자 | 읽기 캐시, 출처, 디버깅. 대화 ID의 대체물로 우선하지 않음 |
| event ID | 대화 안의 실제 메시지/이벤트 식별자 | 중복 제거, 스트리밍 갱신, 소식·읽음 버전 |

- Codex는 첫 owner `session_meta`의 `payload.id` → `session_id` → `thread_id`를 사용한다. 뒤에 상속된 부모 metadata가 있어도 owner를 바꾸지 않는다. 파일명이 달라도 native ID가 같으면 continuation으로 합친다.
- Claude root는 `sessionId`; subagent는 마지막 `subagents` 경로 앞 부모 UUID와 agent ID를 함께 사용해 `subagent:<parent>:<agent>`로 범위를 나눈다. `parentUuid` 하나만으로 부모 세션을 추론하지 않는다.
- OpenClaw는 agent namespace와 DB의 current session ID 또는 JSONL header ID를 사용한다. DB parent key는 정확한 sessionKey로 연결하고 같은 agent의 native ID로도 해석한다. 다른 페르소나의 부모는 정확하고 유일한 key 매치일 때만 연결한다.
- 원본 ID를 얻지 못한 일반 fallback은 `identity.evidence`에 남긴다. 부분 Codex 파일에서 owner header를 놓치면 파일 ID로 새 동료를 만들지 않고 오류로 격리한다.
- 명시적 fork/자식은 별도 세션이다. 비슷한 제목·같은 cwd·같은 브랜치는 병합 근거가 아니다.

`mergeSessions`는 이미 정규화된 `Session.id`의 정확한 일치만 본다. 최신 관측의 상태를 기준으로 하고, 시작 시각은 가장 이른 값, native 제목은 우선 보존, 이벤트·결과 링크·`sourcePaths`는 합친다. 토큰 snapshot은 조각마다 더하지 않는다. 마지막 이벤트 180개를 넘으면 `partial`을 남긴다.

## 원본별로 읽는 범위

| 소스 | 경로 / 형식 | 주요 보완과 경계 |
| --- | --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/projects`, 기본 `~/.claude/projects`; JSONL, sessions-index, `.meta.json` | custom/AI/agent title 우선순위와 sidecar 역할. tool-use는 진행, end_turn/stop은 최종 근거 |
| Codex | `$CODEX_HOME/sessions`, 기본 `~/.codex/sessions`; `session_index.jsonl`, `state_N.sqlite`의 threads | 표시 이름은 threads.name → index → 정제된 threads.title. 명시 commentary/final 및 lifecycle; native metadata 우선 |
| OpenClaw | `$OPENCLAW_STATE_DIR/agents`, 기본 `~/.openclaw/agents`; agent별 sessions와 `agent/openclaw-agent.sqlite` | JSONL이 이관되어 없어도 DB 수집. DB는 최근 180개 + 초기 12개 표본. seq 외 rewrite watermark로 변경 감지 |

기본 수집 상한은 공급자당 최근 120개, 설정 범위는 60~300개다. JSONL은 파일 mtime 기준 탐색 후보에도 상한을 적용하므로 모든 대화 조각을 영구 보장하는 것이 아니다. DB/파일 결과는 병합 후 다시 상한을 적용한다. 오류 보존 경로에서 마지막 정상 기록을 추가로 남길 수 있다.

일반 JSONL 읽기 예산은 3 MiB head+tail이며 앞 구간은 최대 768 KiB다. **예외로 첫 metadata 한 줄**을 Orca의 10 MiB 레코드 한도까지 복구한다. 열린 파일의 크기를 기준으로 읽고, 진행 중 append/rotation의 반쪽 줄을 완성된 이벤트로 처리하지 않는다. 누락/잘림은 `partial`로 표시한다. 이것은 전체 transcript를 페이지별로 전부 읽는 엔진이 아니다.

## 이벤트·활동·소식으로 가는 과정

1. `parseRecords`는 공개 user/assistant, tool/result, lifecycle만 정규화한다. 내부 analysis/reasoning과 자동 환경 wrapper는 사용자 활동으로 취급하지 않는다.
2. 이벤트 키는 native uuid/id를 우선한다. 없으면 timestamp/kind/text hash를 사용한다. 전송 페이지의 `ordinal`은 다른 파일에서도 반복될 수 있어 새 이벤트 키로 쓰지 않는다.
3. 같은 native 이벤트의 새 snapshot은 이전 값을 갱신한다. 옛 ordinal 키는 `legacyId`로 제공하되 동일 내용·시각 버전에서만 receipt를 옮긴다. ID 없는 동일 시각·종류·본문은 구별할 수 없다는 한계가 있다.
4. `activity.ts`는 현재 턴의 공개 진행/응답 → 요청 → 기록 상태 순으로 발췌한다. 도구 이름은 별도 보조 정보다. 전체 원문 대신 짧은 발췌가 쓰였음을 유지한다.
5. `conversation.ts`는 request/progress/reply/message/work로 분류한다. 원본 phase가 없으면 기타 응답이다. 원본 구간 밖 소식으로 보완한 메시지는 `excerpt=true`와 발췌 라벨을 갖는다.
6. `notices.ts`와 `store.ts`는 소식 저장과 중요 배지 범위를 분리한다. 기본 배지는 확인된 final과 미해결 입력 요청이다. 사용자의 read/dismiss는 ID+version에만 적용한다.

사용량은 session 누적과 수집 표본 범위, 현재 문맥 근사치를 구분한다. Codex cumulative snapshot을 합산하지 않고, Claude streaming usage는 메시지 ID별 중복을 제거한다. 값이 없으면 null이며 0으로 만들어내지 않는다.

## 저장·캐시·실패 처리

원본 JSONL/SQLite는 읽기 전용이다. 앱 자체 SQLite에는 세션 관측 캐시, 별명·메모·핀, 설정/좌석 순서, notices/notice_observed를 분리해 저장한다. 관측 갱신은 사용자 메모나 읽음 처리를 덮어쓰지 않는다.

JSONL 읽기 캐시는 size+mtime+파서 버전, OpenClaw DB 캐시는 행 갱신 시각/seq/rewrite watermark/이름·관계 등으로 무효화한다. 파서 의미가 바뀌면 service와 OpenClaw의 캐시 버전도 검토한다. Git 위치 관측은 별도 15초 캐시다. metadata/sidecar 이름 갱신은 파일 본문 변경이 없더라도 반영한다.

한 파일/노드의 손상은 다른 정상 세션 수집을 중단하지 않는다. 일부 실패 시 해당 공급자의 마지막 정상 기록을 유지하고 connector에 오류를 표시한다. 원본이 사라진 경우와 일시 읽기 실패를 같은 삭제 신호로 취급하지 않는다. 새 플랫폼의 스키마가 달라졌을 때 조용히 다른 ID를 만들어 우회하지 않는다.

## 실패 사례와 회귀 근거

| 증상 | 원인 / 방지 원칙 | 관련 검증 |
| --- | --- | --- |
| 한 Codex 대화가 여러 동료로 나뉨 | 파일 UUID를 owner ID보다 우선함. native identity와 continuation 병합으로 수정 | `ingestion-conformance.test.ts`, `adapters.test.ts` |
| 자식과 부모가 합쳐지거나 서로 다른 Claude 자식이 충돌 | 상속 metadata 또는 짧은 agent ID만 사용. owner 고정·parent namespace 적용 | `ingestion-conformance.test.ts`, `orca-origin.test.ts` |
| 중간 도구 호출이 공개 설명을 밀어냄 | tool 명칭을 주 행동으로 사용. 공개 activity와 tool을 분리 | `activity.test.ts`, UI public progress |
| OpenClaw 이관 뒤 사라짐 / 재작성 내용이 안 바뀜 | JSONL만 읽거나 seq만 캐시. DB 어댑터·rewrite watermark 적용 | `adapters.test.ts`, `service.test.ts` |
| 지난 소식이 분류 변경 후 다시 미확인으로 생김 | observed-only cursor의 버전 전환 누락. receipt와 관측 cursor 모두 재분류 | `conversation-news.test.ts`, `store.test.ts` |
| 큰 첫 metadata를 읽다가 EBADF / 잘못된 ID | stream iterator가 공유 fd를 닫음. bounded generator가 fd를 소유 | `ingestion-conformance.test.ts` |
| 모든 브랜치가 미확인 또는 main으로 오표시 | 기록 Git과 현재 Git 혼동. detached/비 Git/null을 별도 표시 | `office-layout.test.ts`, `office-policy.test.ts` |

세션 중복을 조사할 때는 개인 본문 대신 provider, canonical ID, `identity.evidence`, transport ID, `sourcePaths`, relation, partial, revision을 먼저 비교한다. 관계가 잘못되었는지, 단순 공간 그룹이 잘못되었는지를 분리한다. 실제 읽음 이력을 삭제하거나 DB를 초기화해서 재현을 숨기지 않는다.

## 외부 모듈 업데이트 / 새 플랫폼 도입

외부 모듈을 바꿀 때 고정 커밋·라이선스·원본 checksum·runtime 수정 범위를 함께 갱신한다. 기존 fixture와 원본 origin 테스트, byte boundary/large-header/rotation/continuation/namespace/streaming/receipt 테스트를 유지한다. 필요하면 원본 DB를 읽기 전용으로 복제해 로컬 replay하고 결과만 기록한다.

새 플랫폼은 `Session`, `RuntimeObservation`, `SessionRelation`, `OfficeEvent`, `Usage`, source/partial 근거를 채운다. 적어도 root/continuation/child 또는 미지원 관계, 공개/비공개 메시지, phase 불명, 사용량 누락, 재시작·잘림을 합성 fixture로 검증한다. 저장소·UI에 공급자별 임시 분기를 추가하기보다 [공통 규격](../golden/OFFICE-OBSERVATION-PROTOCOL.md)을 명시적으로 발전시킨다. 라이선스/의존성이 맞지 않거나 의미가 다른 전체 앱은 통째로 편입하지 않는다.

## 동료 투영·내부 실행 분류 (2026-10-05)

이번 변경은 새로운 외부 모듈 복사가 아니다. 이미 vendoring한 Orca의 `readCodexNonUserOrigin` 결과를 자체 `identity.ts`가 공통 `Session.origin`으로 번역한다. ordinary thread_spawn의 역할 이름이 guardian인 경우와 내부 guardian origin을 구별한다. 내부 구현의 목적/안전성은 추측하지 않는다.

OpenClaw의 `session_nodes` optional 열은 PRAGMA로 확인한다. `created_via`, `created_actor_type`, `session_key`가 없어도 기존 DB를 읽는다. cron은 native metadata로만 구분하고 디렉터리 agentName은 공통 actor가 된다. 캐시 정책 키는 office-v8로 올려 기존 관측을 다시 정규화한다. JSONL/SQLite 조각 병합은 이미 확보한 origin/부모/actor 근거를 보존한다.

자체 `src/shared/residents.ts`는 canonical Session 목록을 표시용 동료로 투영한다. OpenClaw 실행을 한 데이터 행으로 병합하지 않으며, 서브세션·내부 실행을 숨겨도 상세/검색/MCP/소식 원본이 남는다. 따라서 페르소나 화면 정리와 세션 중복 병합은 서로 다른 단계다. 좌석은 actor key로 저장하고 개인 메모·별명·접기 영수증은 기존 session/event key를 유지한다. 상세 실행 선택은 정확한 원본 ID로 돌아간다.

검증 fixture는 `tests/residents.test.ts`와 `tests/ui/residents.spec.ts`에 있다. optional DB 열, cross-persona parent key, metadata가 없는 최신 fragment, 대표 실행 교체, 재시작 영수증/좌석, 내부 작업을 이름으로 오분류하지 않는 경우를 포함한다.

### 현재 작업 경계 보존

office-v9는 `taskStartedAt`을 새로 채우도록 캐시를 갱신한다. 정제된 공통 이벤트에서 요청/명시적 턴 시작을 찾는 자체 `shared/lifecycle.ts`를 사용한다. 본문·소스명을 UI에서 다시 분석하지 않는다. 어댑터의 events 180개 절단과 store snapshot의 4개 절단 전에 경계를 추출하고, partial tail 재수집에서 이미 관측한 경계가 사라져 보조가 재등장하지 않도록 저장한다. 전체 native history가 제공되지 않으면 경계를 추측하지 않고 일반 대기 정책으로 제한한다. fixture는 `tests/lifecycle-settings.test.ts`와 `tests/residents.test.ts`다.


### office-v10 · 사용 표본과 실행 경로

새 optional UsageEntry/WorkingLocation을 채우기 위해 JSONL/OpenClaw SQLite 캐시 버전을 올렸다. native Codex response 사용량을 token_count보다 우선하고, 메시지별 streaming 비용과 별도 ledger를 추가했다. 실제 shell workdir/cwd와 literal cd는 어댑터에서 읽고 Codex wrapper는 Acorn 구문만 분석한다. 값에 따라 실행하거나 UI에서 원본을 재분석하지 않는다. [사용량·실행 위치와 레퍼런스 근거](USAGE-AND-WORKSPACE.md).
