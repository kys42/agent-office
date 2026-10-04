# 세션 수집 레퍼런스 재사용 결정 · 2026-10-04

이 문서는 비교 당시의 선택 근거다. 현재 처리 흐름·모듈 소유 경계·장애 분석 순서는 [세션 기록 분석](SESSION-INGESTION.md), 제품 정책은 [골든 문서](GOLDEN-OFFICE-POLICY.md)를 따른다.

## 무엇이 잘못됐나

초기 조사에서 6개 저장소를 내려받았으나 세션 수집기는 TypeScript로 새로 작성했다. 당시 직접 재사용한 구현은 Pixel Agents의 경로 탐색이었다. `참고했다`와 `모듈을 도입했다`를 구분해야 한다.

부모 기록이 포함된 fork를 구분하는 수정에서 파일명 UUID를 대화 ID보다 우선했다. 현재 Codex Desktop의 이어쓰기 파일은 파일명 UUID가 바뀌어도 첫 `session_meta.payload.id`가 원래 대화 ID다. 이 때문에 현재 대화가 여러 캐릭터로 나타나고 원래 캐릭터는 쉬는 것처럼 보였다. 당시 fork 테스트만 있고 이어쓰기 파일 테스트가 없었다. 외부 구현을 충분히 대조하지 않은 자체 구현/검증 결함이다.

직전 수정은 이어쓰기/서브세션 구분을 복구했다. 이번 변경은 기존 레퍼런스를 실제 코드 단위로 비교하고, Orca를 추가로 내려받아 읽기 모듈을 편입한다.

## 실제 코드 비교

| 후보 / 고정 커밋 | 확인한 코드 | 선택과 이유 |
|---|---|---|
| [Orca](https://github.com/stablyai/orca/tree/ea6a6d60774ac2b74bb6692d1798e3ab13b99ae0) · MIT | `src/main/ai-vault/session-scanner-jsonl-reader.ts`, `session-transcript-record-budget.ts` | **모듈 편입.** 바이트 오프셋, UTF-8/CRLF 경계, 불완전 꼬리, 큰 레코드 건너뛰기를 처리하는 fold를 유지. Orca의 WSL 파일 접근 대신 읽기 전용 bounded stream을 주입한다. 세 플랫폼의 JSONL이 모두 이 모듈을 통과한다. |
| Orca · 같은 커밋 | `session-scanner-codex-non-user-origin.ts` | **모듈 편입.** source union, 명시적 thread_source 우선순위, agent_type 별칭, parent/nickname/path를 읽는다. import만 바꾸고 판별 함수는 그대로 사용. 원본 테스트 17개를 Node 테스트 러너로 연결. |
| Orca · 같은 커밋 | `session-scanner-codex-parser.ts`, `codex-session-root-dedup.ts`, `session-root-dedup.ts` | **전체 편입하지 않음.** Vault는 non-user thread를 제외하며 파일명/host/root별 alias의 대표 하나를 선택한다. 사무실은 서브에이전트를 보여주고 이름이 다른 이어쓰기 파일의 이벤트를 합쳐야 한다. 계정 관리/WSL/실행/검색 모델 의존성도 크다. |
| [Agent Sessions](https://github.com/jazzyalex/agent-sessions/tree/b7893c772b0014918211f1c45a5ab58add229703) · MIT | `Model/Session.swift: deriveCodexInternalSessionID`, `Services/SessionIndexer.swift` | 내부 ID와 파일 ID 분리 원칙 채택. 다만 목록은 file-path hash 중심이며 이 규칙만으로 우리 이어쓰기 병합은 완성되지 않는다. `payload.id`가 자식 자신이고 `session_id`가 부모일 수 있다는 경우도 검증. |
| Agent Sessions · 같은 커밋 | `Services/ClaudeSessionParser.swift: detectSubagentInfo`, 제목 우선순위 | **TypeScript 이식.** 마지막 `subagents` 경로 앞 부모 UUID, 중첩 workflows, 옆 `.meta.json`의 역할, custom-title > ai-title > agent-name > prompt. description fallback은 Orca `readSubagentMeta`와 비교해 적용. |
| Agent Sessions · 같은 커밋 | `Services/OpenClawSessionParser.swift` | header ID 우선과 agent namespace 원칙 확인. JSONL 파서 전체로 현재 Mac의 `session_nodes` / `transcript_events` SQLite를 대체할 수 없어 기존 SQLite 어댑터 유지. |
| [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents/tree/3537e14) · MIT | `server/src/sessionRouter.ts`, `transcriptParser.ts` | 훅 session→agent 라우팅과 타이머/방송 모델. 이미 실행 중인 세 플랫폼의 저장 기록을 읽는 공통 파서로는 부적합. 기존 BFS 이외 추가 편입 없음. |
| [Claude-Mem](https://github.com/thedotmack/claude-mem/tree/a1951f2ad247330b2b5d58a1e0c7efeef4a03be5) · Apache-2.0 | `src/services/transcripts/processor.ts`, `field-utils.ts`, `src/shared/transcript-parser.ts` | context 먼저 학습하는 순서는 참고. processor는 worker HTTP/관측 DB/훅 처리에 결합. field-utils를 가져오려고 새 schema DSL을 넣는 것보다 현재 필요한 identity 경계를 분리하는 편이 단순하여 편입 보류. |
| AgentPet `60b6f0d` · MIT | `Sources/AgentPetCore/TranscriptReader.swift`, `SessionStore.swift` | 훅의 sessionId 기반 펫 상태가 중심. 현재 수집기 대체 후보에서 제외. |
| CASS `306d6e2`, MCP Agent Mail `3fad5ec` | 앞선 소개/라이선스 확인 범위 | 상세 파서 비교 대상으로 삼지 않았다. 추가 rider가 있는 소스를 재사용했다고 주장하지 않는다. |

## 적용한 구조

```text
JSONL → Orca byte reader → provider identity / event decoding ┐
OpenClaw SQLite → read-only adapter → native session identity ├→ exact session merge
Native index / sidecar → titles and metadata                 ┘  → observation v1 → office policy/UI
```

- `server/adapters/identity.ts`: 세 플랫폼의 원본 대화 ID와 관계를 먼저 결정. Codex는 첫 owner header가 뒤의 상속 metadata/파일명에 덮이지 않는다.
- `server/adapters/files.ts`: 열린 파일의 크기로 읽기 snapshot을 고정. 평소 3 MiB head/tail. 첫 메타데이터 줄만 별도로 최대 10 MiB 레코드 한도까지 복구한다. 큰 첫 줄 때문에 ID를 놓친 Codex는 새 캐릭터를 추측 생성하지 않고 마지막 수집 결과를 보존한다.
- `server/adapters/merge.ts`: provider/agent namespace를 포함한 정확한 native ID로만 병합. cwd, 프로젝트명, 제목, branch 유사성으로는 병합하지 않는다. 모든 읽은 경로를 `sourcePaths`에 남긴다.
- Claude 자식은 `subagent:<parent-id>:<agent-id>`로 식별. 다른 부모가 같은 짧은 agent ID를 써도 합쳐지지 않는다. `parentUuid`는 메시지 관계이며 세션 부모 ID로 사용하지 않는다.
- transport `ordinal`은 메시지 ID가 아니다. native event ID가 없으면 timestamp/kind/text fingerprint를 사용. 반복 native 이벤트는 마지막 snapshot으로 갱신한다.
- 이전 ordinal 기반 소식의 내용/시각 버전이 정확히 같을 때만 기존 읽음/닫음 기록을 새 event key로 옮긴다. 옛 기록을 새 알림으로 재생하지 않는다.

## 원본·변경·검증 관리

`vendor/orca/upstream`에 원본, `runtime`에 실제 import 모듈, `manifest.json`에 SHA와 파일별 checksum/변경 내용을 둔다. `.research` 경로를 런타임에서 import하지 않는다. `vendor/agent-sessions`에 이식 근거와 MIT LICENSE를 보존한다. 두 LICENSE는 `public/licenses`를 거쳐 빌드와 데스크톱 패키지에 포함된다.

검증: 원본 checksum, Orca origin 테스트 17개, 모든 UTF-8/CRLF 경계 분할, 10 MiB 초과 레코드 뒤 복구, 큰 첫 header, native ID와 transport ID 충돌, fork/child/root, 중첩 Claude sidecar, 세 플랫폼 동일 native ID 병합/namespace 격리, ordinal 충돌, streaming snapshot, 읽음/닫음 이관. 기존 상태/좌석/OpenClaw SQLite rewrite 테스트도 함께 실행한다.

## 현재 한계와 다음 도입 기준

완전한 transcript 검색 엔진이나 플랫폼 전체 런타임을 도입한 것은 아니다. bounded sample, 최대 수집 개수, 프로세스 상태가 아닌 기록 기반 상태 추정은 유지한다. 외부 파서가 현재 로컬 SQLite와 paginated/new event 형식을 모두 지원한다고 가정하지 않는다. source schema가 바뀌면 해당 형식을 실제로 재현하는 fixture부터 추가한다.

새 모듈은 (1) source read-only, (2) native/transport/event ID 구분, (3) 부모·분기 의미 보존, (4) 부분 기록/rotation 처리, (5) 의존성과 라이선스, (6) 기존 fixture와 로컬 replay 통과를 만족할 때 편입한다. 공급자 모듈이 UI 좌석/상태 정책을 직접 결정하지 못한다.
