# 참고 저장소 조사와 재사용 결정 · 2026-10-04

기획: 사용자 첨부 `agent_office_feature_catalog_2026-10-03.pdf` 32쪽. 원문이 제안한 140개 후보를 제품 로드맵으로 읽고, 이번 결과물은 **관찰 → 이해 → 검색 → 근거 있는 인수인계**에 집중했다.

디자인: [kys42/claude-skills](https://github.com/kys42/claude-skills/tree/claude/agent-desktop-pet-design-9aex2v/agent-office), `9a644d65e651e55213af2fe409d09e37f12a849e`. `references/design-source/`에 원본 보존. E 맵·캐릭터·책상·걷기 스프라이트를 그대로 가져오고 React 상호작용, 창·수집 구조를 새로 구현했다. 원본 mock의 승인 버튼은 실제 권한 제어로 복제하지 않았다.

이번 추가 조사·실제 편입 결정은 [세션 수집 레퍼런스 감사](INGESTION-REFERENCE-AUDIT.md)를 기준으로 한다. 초기 6개에 Orca를 추가했으며, 이제 JSONL reader와 origin classifier는 외부 모듈을 사용한다.

## 내려받은 저장소

`.research/`는 Git ignore된 로컬 비교 소스이며 앱 패키지에 포함되지 않는다. SHA는 조사 당시 checkout 기준이다.

| 저장소 | SHA | 확인 범위 / 선택 |
|---|---|---|
| [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) | 3537e14 | 공급자 경계·픽셀 엔진·tileMap 경로 탐색. MIT. 4방향 BFS를 축소해 도입했다. 현재 고정 좌석 UX에서는 자동 걷기를 제거하여 경로 모듈은 확장용으로 보존한다. 원본과 LICENSE는 vendor/pixel-agents, 고지는 THIRD_PARTY_NOTICES.md. 외부 캐릭터·가구 아트는 복사하지 않았다. |
| [Agent Sessions](https://github.com/jazzyalex/agent-sessions) | b7893c7 | Claude/OpenClaw 파서, discovery·indexer, Codex usage/state 참고. MIT. Swift 전체를 포크하지 않고, 이번 감사에서 Claude 중첩 subagent 경로/sidecar 및 제목 우선순위를 MIT 조건으로 이식했다. 문서 일부는 오래된 모델 필드 설명이 있어 실제 원본을 우선했다. |
| [Orca](https://github.com/stablyai/orca) | ea6a6d6 | JSONL byte reader와 Codex non-user origin 모듈 편입. MIT. 원본/수정본/파일 checksum을 vendor/orca에 보존. |
| [Claude-Mem](https://github.com/thedotmack/claude-mem) | a1951f2 | SQLite/session schema·worker·관측과 메모의 분리 구조 확인. Apache-2.0. 사용자 모델 호출이나 새로운 상주 서버를 자동 설치하지 않도록 직접 런타임 포함은 보류했다. |
| [AgentPet](https://github.com/ntd4996/agentpet) | 60b6f0d | 펫·상태 감지·레벨 경험 비교. MIT. 공급자 로그에 따른 상태의 오판 가능성을 검토. 토큰 소비를 보상하는 성장 규칙은 도입하지 않았다. |
| [CASS](https://github.com/Dicklesworthstone/coding_agent_session_search) | 306d6e2 | 커넥터 목록·프로젝트 소개 및 라이선스 확인. MIT에 추가 rider 존재. 소스 편입·실행·세부 분석은 보류했다. |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | 3fad5ec | 프로젝트 소개 및 라이선스 확인. MIT에 추가 rider 존재. 메시징 시스템과 소스 편입은 보류했다. |

## 현재 포맷에서 발견한 차이

1. OpenClaw 원본 JSONL이 없어도 `session_nodes`와 `transcript_events`에는 기록이 있다. 하위 agent 내부의 Codex JSONL을 OpenClaw의 본 세션으로 잘못 집계하면 중복된다. 탐색은 `agents/*/sessions`와 agent SQLite로 제한했다.
2. 현재 Codex는 기존 `token_count`와 새로운 `token_usage_record.thread_token_usage`가 함께 존재한다. 두 개를 합산하면 중복된다.
3. Codex 제목은 transcript의 첫 user block보다 threads.name / session_index / threads.title 순으로 읽어야 실제 붙인 이름과 일치한다. 시스템 프롬프트·AGENTS 지시가 제목이 되지 않게 정리한다.
4. Claude assistant streaming 조각은 같은 message ID에 usage snapshot이 반복될 수 있다. 메시지별 최신 최대 output을 사용한다.
5. 일부 CLI 명령이 셸 PATH에서 실행되지 않아도 세션 로그와 앱 데이터는 존재했다. 연결 상태와 실행 파일 설치 상태를 같은 신호로 보지 않는다.
6. 큰 기록의 tail만 읽으면 원래 세션 ID와 작업 위치를 잃는다. bounded head+tail, 버전·출처·부분 수집 표시를 함께 유지한다.
7. OpenClaw 재작성은 seq가 유지될 수 있으므로 rewrite watermark도 캐시 버전에 포함한다.

## 기능 카탈로그와 이번 구현

구현: 안정적인 좌석 순서·프로젝트별 동적 가구 배치와 한 화면 맞춤, 시간별 대기·보관, 실제 세션 이름, 요청/진행/최종 대화 필터·더 보기, 최종 중심 소식함, GitHub PR/이슈 메타데이터와 링크, 3종 관찰, 고유 ID·별명·모델·작업 위치·브랜치 기록, 보수적 상태·행동, 미니 창, 검색, 원문 이벤트 근거, 메모, 결과 링크, 개인 결과 확인, 보관·핀, 인수인계 revision 확인·Markdown, 읽기 MCP, 프로젝트 범위 정책, 화면 내용 숨기기, 동작 줄이기, 로컬 패키지. 초기 페이징 사무실은 [골든 정책 v3](GOLDEN-OFFICE-POLICY.md)의 동적 공간으로 대체했다.

미구현: 실제 프로세스/승인 연결, 세션 제어·메시징, AI 요약·임베딩·토픽 검색, 예약 회고, Employee/XP, 스킨 업로드 UI, 원격 연결, 공증·자동 업데이트. 기존 스프라이트 manifest 규격은 유지하므로 스킨의 파일 교체·추가 구현을 이어갈 수 있다.
