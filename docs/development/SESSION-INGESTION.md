# 세션 기록 분석과 수집 모듈

기준: 2026-10-05. 실제 import와 구현을 기준으로 **직접 사용하는 외부 모듈 / 정책을 이식한 코드 / 자체 구현 / 조사만 한 후보**를 구분한다. 외부 전체 앱을 가져와 실행하는 구조가 아니다.

## 처리 흐름

```text
OfficeService (5초 전체 수집, 읽기 범위·오류 격리
               + 일하는 동료만 1초 hot path: stat·fs.watch 힌트 → 같은 파일 단계 → 부분 저장)
  ├─ JSONL 탐색 → RecordWindowCache(append 증분 / readRecords) → Orca byte reader
  │                            → resolveIdentity + parseRecords
  ├─ Codex/Claude index·DB·sidecar → 이름·작업 위치 보완
  └─ OpenClaw read-only SQLite → resolveIdentity + parseRecords + DB 상태
        ↓
  mergeSessions (동일 canonical ID의 조각만 병합)
        ↓
  enrichWorkspaces (Git common-dir/worktree/현재 Git 관측)
        ↓
  Claude 실행 기록 overlay (sessions/<pid>.json의 waiting → 호출, 파싱 캐시 뒤 매 수집)
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
| Claude Code | `$CLAUDE_CONFIG_DIR/projects`, 기본 `~/.claude/projects`; JSONL, sessions-index, `.meta.json`. 실행 중 상태는 `$CLAUDE_CONFIG_DIR/sessions/<pid>.json` | custom/AI/agent title 우선순위와 sidecar 역할. tool-use는 진행, end_turn/stop은 최종 근거. AskUserQuestion·ExitPlanMode는 결과 전까지 호출. 실행 기록은 권한 확인 대기만 읽음([아래](#claude-실행-기록과-호출-office-v11)) |
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
6. `notices.ts`와 `store.ts`는 소식 저장과 중요 배지 범위를 분리한다. 기본 배지는 확인된 final과 미해결 입력 요청이다. 입력 요청은 아직 결과가 없는 열린 요청만 소식 후보다(`isOpenRequest`). 사용자의 read/dismiss는 ID+version에만 적용한다.

사용량은 session 누적과 수집 표본 범위, 현재 문맥 근사치를 구분한다. Codex cumulative snapshot을 합산하지 않고, Claude streaming usage는 메시지 ID별 중복을 제거한다. 값이 없으면 null이며 0으로 만들어내지 않는다.

## 저장·캐시·실패 처리

원본 JSONL/SQLite는 읽기 전용이다. 앱 자체 SQLite에는 세션 관측 캐시, 별명·메모·핀, 설정/좌석 순서, notices/notice_observed를 분리해 저장한다. 관측 갱신은 사용자 메모나 읽음 처리를 덮어쓰지 않는다.

JSONL 읽기 캐시는 size+mtime+파서 버전([증분 읽기](#jsonl-증분-읽기-45)는 그 아래 단계), OpenClaw DB 캐시는 행 갱신 시각/seq/rewrite watermark/이름·관계 등으로 무효화한다. 파서 의미가 바뀌면 service와 OpenClaw의 캐시 버전도 검토한다. Git 위치 관측은 별도 15초 캐시다. metadata/sidecar 이름 갱신은 파일 본문 변경이 없더라도 반영한다.

한 파일/노드의 손상은 다른 정상 세션 수집을 중단하지 않는다. 일부 실패 시 해당 공급자의 마지막 정상 기록을 유지하고 connector에 오류를 표시한다. 원본이 사라진 경우와 일시 읽기 실패를 같은 삭제 신호로 취급하지 않는다. 새 플랫폼의 스키마가 달라졌을 때 조용히 다른 ID를 만들어 우회하지 않는다.

## 실패 사례와 회귀 근거

| 증상 | 원인 / 방지 원칙 | 관련 검증 |
| --- | --- | --- |
| 한 Codex 대화가 여러 동료로 나뉨 | 파일 UUID를 owner ID보다 우선함. native identity와 continuation 병합으로 수정 | `ingestion-conformance.test.ts`, `adapters.test.ts` |
| 자식과 부모가 합쳐지거나 서로 다른 Claude 자식이 충돌 | 상속 metadata 또는 짧은 agent ID만 사용. owner 고정·parent namespace 적용 | `ingestion-conformance.test.ts`, `orca-origin.test.ts` |
| 중간 도구 호출이 공개 설명을 밀어냄 | tool 명칭을 주 행동으로 사용. 공개 activity와 tool을 분리 | `activity.test.ts`, UI public progress |
| OpenClaw 이관 뒤 사라짐 / 재작성 내용이 안 바뀜 | JSONL만 읽거나 seq만 캐시. DB 어댑터·rewrite watermark 적용 | `adapters.test.ts`, `service.test.ts` |
| 지난 소식이 분류 변경 후 다시 미확인으로 생김 | observed-only cursor의 버전 전환 누락. receipt와 관측 cursor 모두 재분류 | `conversation-news.test.ts`, `store.test.ts` |
| 플랜 승인·권한 확인을 기다리는데 부르지 않음 | ExitPlanMode를 일반 도구로 봄, 권한 확인은 transcript에 없음. ExitPlanMode를 입력 요청으로, 실행 기록 `waiting`을 호출로 | `live-calls.test.ts` |
| 업그레이드 뒤 지난 플랜 승인이 한꺼번에 '응답 필요'로 | 결과가 있는 지난 요청까지 소식 후보로 봄. 열린 요청만 후보, 퇴근 시간보다 오래된 요청은 소식으로 만들지 않음 | `live-calls.test.ts` |
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

## Claude 실행 기록과 호출 (office-v11)

플랜 승인과 권한 확인은 사람이 답해야 넘어가는 순간이지만 transcript만으로는 일부만 보인다. 판단 규칙은 [상태 정책서](../golden/STATUS-POLICY.md#호출call의-근거)가 정본이고, 여기서는 수집 경계를 적는다.

- **플랜 승인(transcript)**: Claude 플랜 모드는 `ExitPlanMode` 도구 호출로 승인을 묻는다. `parseRecords`는 이를 AskUserQuestion처럼 `intent: request-input`, 상태 `call`, 이유 `planApproval`로 정규화한다. 결과(`tool_result`)가 기록되면 이전처럼 작업으로 돌아간다. 파서 의미가 바뀌어 JSONL 캐시 키를 office-v11로 올렸다.
- **호출과 결과 짝짓기**: Claude 이벤트 ID는 레코드 uuid라 호출과 결과의 ID가 다르다. 그래서 tool/result 이벤트에 원본 호출 ID를 optional `OfficeEvent.callId`로 남긴다(Claude `tool_use.id`/`tool_use_id`, Codex `call_id`). 이벤트 ID·소식 ID·버전은 바꾸지 않는다. `callId`가 없는 옛 기록은 `<call id>:result` 이벤트 ID로만 짝짓는다.
- **권한 확인(실행 기록)**: 일반 권한 확인(Bash 승인 등)은 transcript에서 실행 중인 도구와 같아 보인다. Claude Code가 대화형 프로세스마다 쓰는 `$CLAUDE_CONFIG_DIR/sessions/<pid>.json`(기본 `~/.claude/sessions`)의 `status: "waiting"`·`waitingFor`(예: `permission prompt`)만 근거로 쓴다.
  - **비공개·미문서 형식**이다. 읽는 필드는 `pid`, `sessionId`, `procStart`, `status`, `kind`, `updatedAt`, `statusUpdatedAt`, `waitingFor`뿐이다. 파일 이름과 같은 pid, `^[\w-]{8,80}$` sessionId, `kind` 없음 또는 `interactive`, 64 KiB 이하, 양수 시각, 80자 이하 `waitingFor`만 받는다. 모르는 모양·깨진 JSON·없는 폴더는 아무것도 바꾸지 않는다(transcript 근거만 남음). 이 폴더에는 절대 쓰지 않는다.
  - **같은 프로세스 확인**: `waiting`이고 이번 수집 목록에 있는 세션의 기록만 확인한다. PID가 살아 있고 `ps -o lstart=`(UTC·C 로케일)가 `procStart`와 같아야 한다. 확인 결과는 PID·procStart별로 30초 기억하고, 실패한 확인은 기억하지 않는다. 평소 비용은 수집당 폴더 읽기 한 번이다.
  - **최신 확인**: `statusUpdatedAt`(없으면 `updatedAt`) 뒤에 결과·메시지·턴 경계 이벤트가 있으면 지난 기록으로 보고 무시한다.
  - **적용 위치**: `OfficeService.collect`에서 병합·작업 위치 보완 뒤, 저장 직전에 매 수집 적용한다(`applyLiveWait`). 파싱 캐시에는 넣지 않는다: 대기는 transcript가 그대로여도 바뀐다. 적용하면 상태 `call`, 이유(권한 확인/플랜 승인/일반 대기), 현재 턴에서 결과가 없는 마지막 도구 호출을 `request-input`으로 표시하고 revision에 반영한다. 대기가 끝나면 다음 수집에서 overlay가 사라지고 revision이 다시 바뀌어 저장소와 화면이 갱신된다.
  - **공유**: 읽기·검증 코드는 `server/adapters/claude-live.ts` 하나다. 데스크탑 `desktop/terminals.ts`가 같은 모듈로 세션의 터미널을 찾고, `idle`·`busy`·`shell`일 때, 화면에서 입력창을 확인한 뒤에만 입력한다(작업 중이면 Claude가 대기열에 넣음. `waiting`이면 보낸 글이 승인 응답이 되므로 거절). 서버는 데스크탑 모듈을 import하지 않는다.
- **소식**: 열린 요청만 '응답 필요' 후보다. 결과·이후 메시지·턴 경계가 기록되거나 대기 overlay가 사라지면 해당 소식을 해결한다. 퇴근 시간보다 오래된 미응답 요청은 관측으로만 기억하고 소식을 만들지 않는다. 그래서 업그레이드 뒤 재파싱해도 지난 플랜 승인은 새 미확인 소식이 되지 않는다.
- **묻는 내용(`OfficeEvent.request`, #127)**: 답이 아직 없는 입력 요청 이벤트에 질문(`question`)·플랜(`plan`)을 선택 필드로 붙인다(`server/adapters/requests.ts`). `redact()`와 길이 제한(질문 6·선택지 12·질문 글 1000자·플랜 2만 자) 뒤 정본 그대로 저장하고, 잘렸으면 `truncated`를 단다(앱에서 답하지 않음). 읽을 때 자리표시만 현지화한다(`localizeSession`). 답이 기록되면 다음 파싱에서 사라진다. 이벤트 ID·소식 ID·버전·캐시 키는 바뀌지 않는다. **권한 확인의 내용은 저장하지 않는다**: 다른 도구 호출의 입력(명령·파일·주소·MCP 인수)은 어디에도 남기지 않고, 실행 기록 overlay가 그 호출을 `request-input`으로 바꾸면 렌더러가 도구 이름만으로 권한 요청을 보여 준다. 무엇을 실행하는지는 데스크탑 앱이 화면에서 읽는다([터미널](TERMINAL.md#질문플랜권한-확인에-답하기-127)).
- **가리기 보강(#127)**: 모든 이벤트 글에 `AWS_SECRET_ACCESS_KEY=…`·`*_TOKEN=…`·`*_PASSWORD=…` 같은 환경변수식 비밀, `hf_…`·`glpat-…`·`AIza…`·`AKIA…` 토큰, `--password x`·`--token=x`, `mysql … -pSECRET`, `scheme://user:pass@`, `curl -u user:pass`를 가린다. 이미 자리표시인 값은 다시 가리지 않는다. 비밀이 든 글만 바뀌므로 그런 지난 소식만 버전이 달라질 수 있다.
- **Codex 한계**: Codex rollout에는 승인·권한 요청 이벤트가 없다. `request_user_input`만 호출로 보이고, 명령 승인 대기는 보이지 않는다. 근거가 생기기 전에는 추측하지 않는다.

## JSONL 증분 읽기 (#45)

활성 대화는 몇 초마다 줄이 붙는다. 바뀐 파일마다 3 MiB 창을 다시 읽고 전부 `JSON.parse`하던 비용을 줄이려고 `server/adapters/record-window.ts`의 `RecordWindowCache`가 파일별 읽기 창을 기억한다. **결과 계약은 그대로다**: 같은 바이트에 대해 `readRecords`와 같은 레코드 목록·`partial`을 돌려준다. 파서는 증분으로 바꾸지 않았다. 바뀐 파일은 여전히 메모리의 전체 창으로 `parseRecords`를 다시 실행하므로 usage 중복 제거, 제목 순위, 스트리밍 덮어쓰기, 첫 metadata의 정체성, 시각 정렬이 이전과 같다.

- **append 경로**: 열린 handle의 dev/ino가 같고, 크기가 마지막 완결 줄 끝(`consumedThrough`) 이상이며, 그 앞 최대 64바이트(guard, 전체 읽기 때 같은 handle에서 함께 읽어 둠)가 디스크와 같을 때만 `[consumedThrough, size)`를 Orca fold로 읽는다. 끝의 미완결 줄(UTF-8 중간 포함)은 소비하지 않고 다음 읽기에서 다시 읽는다.
- **창 규칙**: `readRecords`와 같다. 3 MiB 이하이면 전부, 넘으면 앞 768 KiB 안에서 끝나는 줄(head)과 시작 위치가 `size - (3 MiB - 768 KiB)` 이상인 줄(tail)만 남긴다. 그래서 각 레코드의 바이트 시작/끝을 함께 기억한다. `readRecords`는 이 위치를 함께 내는 `readWindow`의 얇은 래퍼다.
- **전체 경로(기존 bounded reader)**: 처음 읽기, inode/dev 변경(교체·rotation), 지난 읽기보다 작아진 크기(미완결 꼬리만 줄어도), guard 불일치, 마지막 전체 확인 후 10분 경과, 한 번에 2.25 MiB를 넘는 증가, 큰 첫 metadata 복구(head 창 안에 완결 줄 없음), 상한 초과 레코드, 예산으로 밀려난 항목. 복구 경로를 거친 파일은 캐시하지 않고 매번 전체 경로로 읽는다.
- **주기적 재확인**: append로 이어 붙인 창은 guard만 믿고 있으므로, 마지막 전체 읽기 후 10분이 지나면 파일이 그 뒤로 조용해서 stamp(size+mtime)가 그대로여도 `OfficeService.collect`가 전체 경로로 한 번 다시 읽는다(`RecordWindowCache.stale` → `verify`). 이전 창과 새로 읽은 레코드를 비교하는 비용은 이 경로에서만 들고, 일반적인 전체 경로 복귀는 어차피 다시 파싱하므로 비교하지 않는다. 대상은 창 캐시에 있는 append 항목과 확인 전에 예산으로 밀려난 append 항목뿐이다. 다시 읽은 레코드·`partial`이 append로 쌓은 것과 같으면 파싱 캐시를 그대로 쓰고 revision도 바꾸지 않는다. 다르면(`drifted`) 다시 파싱하고 revision 키에 확인 표시를 더해 저장소와 화면이 갱신되게 한다. 그 사이 최대 10분은 guard 밖의 같은 크기 덮어쓰기를 놓칠 수 있다. 원본 JSONL은 append-only라는 전제이며, 그 밖의 변경은 위 조건이 전체 경로로 돌린다.
- **mtime 해상도**: 전체 경로로만 읽은 파일은 이전처럼 stamp가 같으면 다시 읽지 않는다. mtime 해상도가 거친 파일시스템에서 같은 크기로 다시 쓰면 다음 변경 전까지 반영되지 않는 기존 한계는 그대로다.
- **예산 (#64)**: 최근 15분 안에 쓰인 파일(일하는 세션)만 창을 남긴다. 그보다 조용한 파일은 다음 변경 때 전체로 읽는다. 창은 매 수집 끝의 `sweep`에서 15분 넘게 읽히지 않으면 버린다. 남긴 원문 줄 바이트 합계는 16 MiB까지다(파싱된 객체의 실제 heap은 더 크다). 넘으면 가장 오래 읽지 않은 파일부터 버리고, 버린 파일은 다음에 전체 경로로 읽는다. 수집마다 공급자별로 이번에 발견한 파일만 남기고(`prune`), 꺼진 공급자의 항목은 비운다. 파싱 캐시(`OfficeService.cache`)도 같은 기준으로 정리하고 4000개 상한을 둔다. OpenClaw DB 캐시는 이번 수집에서 읽지 않은 노드 키를 버린다. revision은 같은 값으로 다시 계산되므로 축출은 의미를 바꾸지 않는다.
- **metadata 캐시**: Codex `session_index.jsonl`·가장 최신 `state_N.sqlite`·`-wal`의 mtime+size와 선택된 DB 이름이 같으면 지난 결과를 그대로 쓴다. DB나 존재하는 index 읽기가 실패한 결과는 기억하지 않는다. Claude는 프로젝트 목록은 매번 읽고 `sessions-index.json`을 파일별 mtime+size로, subagent `.meta.json`은 mtime+size로 기억한다(실제로 없는 경우는 기억하고, 있는데 읽기 실패한 경우는 다음에 다시 읽는다). 테스트는 `resetCodexMetadataCache`/`resetClaudeMetadataCache`로 초기화한다.

검증은 `tests/record-window.test.ts`(단계별 append·3 MiB 경계·미완결 줄·UTF-8 분할·CRLF·무작위 분할이 `readRecords`와 같음, 축소/교체/guard/10분 대조/큰 첫 줄, 예산·prune)와 `tests/incremental-collect.test.ts`(서비스 append 수집과 revision, metadata 캐시)다.

## 일하는 동료 빠른 갱신 (#77)

5초 전체 수집은 그대로 정본·복구 경로다. 그 사이 일하는 동료만 `OfficeService`의 hot path가 1초 안에(파일 감시 힌트가 있으면 1초 미만) 다시 읽는다. 결과 계약: **같은 바이트에 대해 전체 수집이 만들 세션과 같은 세션(revision 포함)** 을 저장한다.

- **파일 단계 공유**: 파일 하나를 세션으로 만드는 단계(파싱 캐시 stamp `office-v11:size:mtime` → `RecordWindowCache` 증분 읽기 → `parseRecords` → metadata 이름 → Claude subagent sidecar)는 `readSession` 하나다. 전체 수집과 hot path가 같은 `cache`·`windows`를 쓰므로 한 파일을 두 번 파싱하지 않는다. hot path가 먼저 읽은 파일은 다음 전체 수집에서 캐시 적중이고 revision도 같아 저장소 쓰기가 없다.
- **직전 값 재사용**: 전체 수집이 저장 직전 세션마다 원본 파일 목록(병합 순서), metadata 맵, 작업 위치 입력(`provider·project·cwd·workingLocation.path`)과 그때 정한 workspace를 기억한다(`KnownSession`). hot path는 탐색·Codex/Claude metadata 읽기·Git을 하지 않는다. 같은 세션의 조각 파일이 여럿이면 전부 다시 단계에 넣어(바뀌지 않은 건 캐시) `mergeSessions`로 합친다. 작업 위치 입력이 바뀌었거나, 파일이 사라졌거나, 다른 ID가 나오면 그 세션은 건드리지 않고 전체 수집에 맡긴다. workspace는 같은 입력이면 같은 값이고(`enrichWorkspaces`와 같은 규칙으로 `locationSource`만 현재 값), Git 관측의 갱신은 다음 전체 수집이 반영한다.
- **대상(hot 집합)**: Claude·Codex·OpenClaw **JSONL** 세션 중 시간 정책을 적용한 상태가 work/think/call이거나, 최종 응답(`done`) 뒤 10초 이내인 세션. OpenClaw DB에서도 나오는 세션은 제외한다(파일만으로 다시 만들 수 없음). 최근 활동순 최대 8개, 나머지는 5초 주기 그대로. 전체 수집 뒤와 hot 처리 뒤마다 다시 고르고, 빠지면 감시를 닫는다.
- **Claude 실행 기록 승격**: hot pass마다 `<claude config>/sessions/*.json`을 한 번 읽는다. hot이 아닌 알려진 Claude 세션의 기록이 `busy`/`waiting`이면 기존 검증(`isLiveProcess`, PID·procStart 30초 메모)을 거쳐 hot으로 올린다(새 요청 도착이 transcript보다 먼저 보임). 승격은 그 세션의 기록이 busy/waiting인 동안 유지된다. hot Claude 세션에는 같은 읽기로 권한 대기 overlay(`applyLiveWait`)를 적용하고, 대기 기록이 바뀌면(`liveWaitSignature`) transcript가 그대로여도 다시 저장한다. ps 호출은 기존 메모를 넘지 않는다.
- **주기와 경합**: 1초 타이머가 hot 파일만 stat해 파싱 캐시 stamp와 비교한다. 바뀐 세션들은 한 번에 처리해 공급자별 `store.stage(sessions, provider)`로 **메모리에만** 받아들이고(아래 '디스크 쓰기는 전체 수집에서') 그 세션들의 변경분만 patch로 보낸다(아래). 변경을 받아들이는 pass는 최소 1초 간격이라 세션별 최소 간격도 1초다. 전체 수집이 진행 중이면 hot pass는 아무것도 하지 않고, hot pass가 진행 중이면 전체 수집이 그 끝을 기다린 뒤 시작한다. 전체 수집은 아무것도 건너뛰지 않는다.
- **변경분만 보내기**: hot pass는 사무실 전체를 다시 만들지 않는다(`emitChanged`). 바뀐 세션의 행만 하나씩 읽어 같은 규칙으로 꾸미고(설정·상태 파생·좌석·`snapshotEvents`), 게시된 동료들에 대해 붙임(`attachSessions`)과 현지화를 한다. 소식은 마지막 전체 목록에서 그 세션들 것만 다시 읽어 합치고, 실어 보낼 소식(`residentNotices`)과 `noticeStats`를 그 목록에서 다시 고른다. 순서는 id만 읽는 쿼리로 확인한다. 게시된 index와 비교해 patch를 만들고 `this.sent`(index·snapshot)·patch 기록을 전체 emit과 같은 방식으로 이어 가므로, 다음 전체 emit의 diff와 웹 폴러가 그대로 동작한다. 바뀐 세션이 다른 동료의 자리를 움직일 수 있으면(구역·핀·보관·관계·actor·background 여부, 붙임이나 책상이 바뀜, 붙지 않은 도우미가 매달림, 새로 보이거나 사라짐, 언어 변경) 전체 `emitSnapshot`으로 돌아간다. 다른 동료의 시간 경과에 따른 변화는 지금처럼 다음 전체 수집이 반영한다. 테스트가 hot patch를 직전 게시본에 적용한 결과와 직후 전체 재구성이 같음을 확인한다.
- **디스크 쓰기는 전체 수집에서**: hot pass는 SQLite에 쓰지 않는다. `OfficeStore.stage`가 `upsert`와 같은 규칙(저장 형태 `storedForm`: 사용량 ledger 합산·작업 위치 유지·`taskStartedAt`, 소식 `ingestNotices`: 후보·ID·버전·receipt·호출 해결·cursor)을 메모리 위에서 그대로 돌린다. 소식·관측 버전·cursor·ledger는 디스크 내용 위에 겹친 사본에 쓰고, 세션 행은 디스크가 담을 형태(JSON 왕복) 그대로 둔다. 이 store의 모든 읽기(사무실 목록·순서·한 행, `get`/`detail`/검색/인수인계, 소식 목록·페이지·전체 읽음, `storedRecords`)가 겹친 내용을 본다. 그래서 열린 작업 카드의 `detail()`도 곧바로 새 내용을 받는다. 사람이 그사이 소식을 읽거나 숨기면(읽음·숨김·안 읽음·봄, 분류 전체 읽음) 그 receipt는 **곧바로 디스크에** 쓰고 겹친 사본도 같이 고친다. 그래서 다음 쓰기가 같은 소식을 쓰고, 그 전에 앱이 꺼져도 receipt는 남는다. 다음 전체 수집의 `upsert`(그 공급자)가 먼저 겹친 소식·관측·cursor·ledger를 **보인 그대로** 쓰고, 이어서 평소처럼 세션을 받아들인다(이때 이전 값은 겹친 행 기준이라 저장 형태가 같다). 소식은 이미 관측된 버전이라 새로 생기지 않으므로 중복·읽음 되돌림·미확인 수 깜빡임이 없다. 수집기가 닫힐 때(`close`)도 겹친 내용을 쓴다(공급자별로 따로, 하나가 실패해도 나머지는 쓴다). 데스크탑 종료는 `before-quit`에서 한 번 멈추고 worker에 stop을 보내 `OfficeService.shutdown()`(새 pass 거절 → 진행 중인 전체 수집·hot pass가 끝날 때까지 기다림 → 닫으며 쓰기)이 끝나거나 3초가 지나면 worker를 끝내고 종료한다. 개발 서버(`server/dev.ts`)도 SIGINT/SIGTERM에서 같은 순서다. 갑자기 죽으면 최대 5초치 겹친 내용이 사라질 수 있지만(receipt는 이미 디스크에 있음), 세션·소식은 다음 실행의 전체 수집이 JSONL에서 다시 만든다.
- **순서**: 세션 목록 순서는 `updated_at` 내림차순, 같으면 id 내림차순이다(디스크 쿼리와 메모리 정렬이 같은 전체 순서를 쓰므로 hot에서 보인 순서가 디스크에 쓴 뒤에도 그대로다).
- **확인 시각**: 1분마다 나가는 확인 시각(`lastSync`·connector)은 전체 office를 게시할 때만 기준을 갱신한다(`healthAt`). hot patch가 계속 나가도 화면의 마지막 동기화 시각은 1분마다 움직인다.
- **메모리**: `emitChanged`가 합칠 기준으로 마지막 전체 소식 목록(`notices.all`)을 들고 있다. 전체 emit이 어차피 만드는 같은 객체들이라 크기는 소식 표 하나(한 번의 `officeView`) 정도다. 겹친 세션은 디스크 소식 사본을 겹쳐 있는 동안만(최대 5초) 가진다.
- **지연되는 읽기**: 같은 store를 쓰지 않는 읽기, 즉 MCP 서버(별도 프로세스의 읽기 전용 연결)와 다른 수집기는 디스크만 보므로 hot 변경을 최대 5초 늦게 본다. `identities`(터미널 찾기)는 디스크의 정체성 필드만 읽으며 hot pass가 이를 바꾸지 않는다.
- **소식 받아들이기 비용**: `ingestNotices`는 세션의 관측 버전을 한 번에 읽고, 버전이 바뀐 이벤트만 `notice_observed`에 쓴다(전에는 후보마다 읽고 매번 같은 값을 다시 썼다). 단계 분류용 기존 소식 확인도 후보마다가 아니라 한 쿼리다. 결과 DB 상태는 같다.
- **fs.watch 힌트**: hot 파일에만 `fs.watch`(persistent:false)를 건다. 이벤트가 오면 150ms 모아(다음 허용 시각보다 이르지 않게) 바로 hot pass를 돈다. 감시 시작 실패·`error` 이벤트는 그 파일을 감시 없이(1초 stat) 두고, hot에서 빠질 때 다시 시도할 수 있게 잊는다. 놓친 이벤트는 1초 stat과 5초 전체 수집이 복구한다. `stop()`은 타이머·힌트·감시를 모두 닫는다.
- **불변**: 저장 기록은 canonical, 소식 ID·버전·이벤트 ID는 그대로다. 일시정지·공급자 끄기에서는 hot 집합이 비워진다.

검증은 `tests/hot-path.test.ts`(append가 전체 수집 없이 다음 tick에 저장·patch, 전체 수집·새 수집기와 같은 revision, 승격·유예·강등·상한 8, 실행 기록 승격과 권한 대기, 전체 수집과 겹치지 않음·한 번만 읽음, 감시 힌트와 감시 실패 시 stat 폴백, `stop()` 뒤 타이머·감시 없음, 부분 upsert, 실행 기록 캐시, hot patch를 직전 게시본에 적용한 결과와 전체 재구성의 동일성(부모·도우미·최종 응답·동시 변경), 전체 재구성으로 되돌아가는 경우, 실어 보내는 소식에서 밀려난 소식 제거, hot pass는 디스크에 쓰지 않고 다음 전체 수집이 보인 그대로 씀, 그사이 읽은 소식이 한 번만·읽은 채로 남음, 바로 쓴 경우와 같은 소식, 닫을 때 기록)다.
