# 2026-10-05 · 계정 한도, 관측 비용과 실제 작업 위치

- 사용량 버튼/오른쪽 패널: Claude OAuth와 Codex CLI rateLimits의 현재 계정 창·잔여량·갱신 시각. 요청 시만 조회·1분 캐시·중복 요청 결합. credential은 서버 메모리만 사용하고 raw 오류/인증값을 화면·DB에 노출하지 않음.
- 세션별 usage ledger: Claude/OpenClaw 메시지, Codex native response 표본을 중복 없이 쌓아 현재 표준 API 기본 단가로 환산. 실제 청구액과 구독 한도는 별개. 알 수 없는 모델/누락 구간/추가 할증 제외를 상세에 표시.
- 명시 실행 cwd/workdir/literal cd와 로컬 Git 검증으로 실제 worktree 팀·브랜치 표시. 시작 cwd/기록 branch 보존. Codex wrapper는 Acorn AST로 읽기만 수행하고 동적 코드·파일 read·PR 추측은 제외.
- 요청 도착 서류 더미·최신 요청 말풍선, 현재 요청 후 5분/15분 집중 연출. 모션 감소·개인정보·stale/완료/다음 요청 경계 적용.
- Orca/Agent Sessions quota 코드를 추가 분석했지만 전체 앱 의존성은 가져오지 않음. 자체 공통 모듈과 새 MIT Acorn dependency로 구현. 골든 v6·관측 규격·개발/리서치 출처·QA 갱신.
- 단위109, 합성 UI25 시나리오, build/format/Electron/MCP 통과. 리뷰 지적 2건 수정 후 재리뷰 통과. 실제 3종 연결과 한도 패널, 4319/HTTPS 확인. 상세 실패/재검증 근거는 QA 문서.
- 기존 PR #1에 추가하고 CI 확인까지. 병합은 별도. 이번 작업의 새 worktree 없음; 다른 UX 작업의 5173 서버는 보존하고 독립 검증 서버는 종료 예정.

# 2026-10-05 · 사무실 퇴근 설정과 작업 단위 보조 동료

- 마지막 활동을 기준으로 대기 1시간~90일, 보관 1~365일을 선택. 자동 보관을 끌 수 있고 핀·직접 보관은 별도로 유지. 사무실 상단 요약에서 설정으로 바로 이동.
- 두 시점은 같은 마지막 활동 기준이며 자동 보관은 반드시 대기보다 뒤. UI에서 대기 기준을 올리면 필요한 경우 보관 시점을 다음날로 맞추고 API의 역전 조합은 저장하지 않음. 기존 4시간/7일 기본 설정 보존.
- 보조 동료는 완료 후에도 메인 옆에서 결과를 남김. 메인의 새로운 요청/명시적 턴 시작이 관측되면 이전 작업의 보조를 접고, 아직 작업 중·확인 필요·핀은 유지. 메인이 대기로 이동하면 끝난 보조를 접음. 상세·원본 기록 보존.
- 공통 taskStartedAt을 원본 공개 이벤트에서 추출. 긴 도구 tail·fragment 병합·snapshot 4개 절단·재수집에도 경계를 보존해 단순 폴링/늦은 결과가 이전 보조를 다시 꺼내지 않음. 공급자별 UI 분기 없음.
- 단위/계약 101개 통과. UI 23개 시나리오 검증(전체 실행 22개 및 option disabled 검증 matcher 수정 후 해당 1개 재실행 통과). TypeScript·build·format 통과. 범위 한정 독립 리뷰에서 새 중·고위험 문제 없음.

# 2026-10-05 · 동료 단위 표시, 열어본 소식, 독립 에셋

- 최신 공개 진행을 한 말풍선으로 표시하고 X를 눌렀을 때 과거 소식이 다시 뜨던 흐름을 제거. 처음 도착/열어봄/읽음을 별도 영수증으로 유지.
- OpenClaw는 사용자가 선택한 페르소나별 한 명과 내부 실행 선택으로 표시. canonical 기록·메모·MCP는 보존하고 안정 actor key로 좌석 연결.
- 끝난 보조 작업·native 내부 실행은 접힌 기록으로, 확인 필요는 노출. 자동/보조의 일반 완료 응답은 기본 중요 소식 숫자에서 제외.
- 작업 중 텍스트/모니터·타이핑과 휴식 구분. 프로젝트 이름표와 소파/침대로 라운지 구성.
- 책상·의자·장비·보조 책상·침대·소파·펫을 독립 renderer/registry로 분리. 팔레트·hue·소품 확장 규격과 추후 저장 정책 문서화. 꾸미기 편집기는 아직 미구현.
- 골든 v4/관측 규격/세션 분석 갱신, development/OFFICE-ASSETS.md 추가. 기존 Orca origin 모듈을 활용하는 자체 정책이며 이번에 새 외부 코드를 복사하지 않음.
- 단위 96/UI 21/build/format/Electron/MCP 통과, 범위 한정 리뷰 완료. 로컬 production preview 재시작, Tailscale HTTPS/API IP 지정 검증 성공(일반 DNS 조회 제한은 QA에 기록).

# 2026-10-05 · 내 요청/진행/최종 대화와 조용한 소식함

- 공통 conversationKind로 요청·진행·최종·단계 불명·도구를 분류. 대화 종류 버튼/건수/말풍선 라벨, 도구 기록 기본 숨김·선택 포함, 필터 간 더 보기 유지와 실시간 필터 보존.
- 소식함 기본 최종 응답, 미해결 질문은 별도 확인 필요, 모든 원문 기록은 전체 기록으로 접근. 읽은 소식 포함과 분류별 일괄 읽음 추가. 기존 읽음·접기/version 계약 유지.
- 상단/책상/보조/미니/상세/서비스 noticeStats의 숫자를 동일 중요 소식 selector로 통일. phase 없는 예전 reply는 완료로 간주하지 않고 원본을 재확인한 경우만 분류 보완. observed-only cursor도 이관하여 과거 진행의 재알림을 방지.
- 수집 구간에서 빠진 직전 응답도 저장된 소식의 발췌로 연결하고 원문 일부임을 표시.
- 진행 요약/PR 카드를 대화 스크롤 영역으로 이동해 작은 화면의 메시지 공간 확보. 종류 버튼은 sticky로 유지.
- 단위 88개·UI 18개·빌드·native·MCP 검증, 실제 preview와 macOS 패키지 갱신. 골든 정책 v3/프로토콜/아키텍처/README/QA 기록.

---

# 2026-10-04 · 실제 가구 배치와 Git 근거 표시

- 6자리 층, 예약 빈자리, 고정 배경 책상/소파/카펫을 메인에서 제거. 순서 토큰과 물리 좌표를 분리한 공통 `office-layout` 엔진으로 프로젝트 바닥 구역·긴 공동 책상·독립 의자·모든 보조 책상을 배치한다.
- 실제 화면에 전체 가구가 들어가도록 배율과 열 수를 계산. 확대/전체 보기 추가. 상태·대화·정렬은 가구 좌표에 영향 없고, 구성/관계/프로젝트/브랜치/창 크기 변경에서만 재배치. 상세창 개방은 배율만 변경한다.
- 기록 branch/gitCommit과 현재 workspace.git을 분리. Codex transcript commit_hash와 DB git_sha 수집. common Git 관측으로 detached/unborn/현재 이름을 구분하고 책상·상세에 같은 표시 함수 사용. TaskDeck의 실제 detached HEAD를 `HEAD · 7b880ba`로 확인.
- 골든 정책 v2, 공통 관측 규격, 아키텍처, README, QA 갱신. 정체성/벤더 수집/미확인 소식 정책은 유지.
- 단위 81개·UI 16개·타입/빌드·native·MCP 통과, macOS 패키지 갱신. 실제 preview 재시작, 사무실 주 7+보조 3을 한 화면에 확인. 로컬/Tailscale 정상 응답.

---

# 2026-10-04 · 레퍼런스 수집 코드 실제 재사용

사용자 지적에 따라 초기 6개 레포를 받았으나 파서를 별도 구현했던 사실과 파일 UUID 우선 회귀 원인을 명시했다. Orca를 추가 checkout(ea6a6d6). JSONL byte reader/record budget와 Codex non-user-origin을 vendor 모듈로 편입하고 원본 테스트 17개도 Node runner로 연결했다. Agent Sessions의 Claude nested workflow parent/sidecar/title precedence를 이식했다. 기존 OpenClaw SQLite read-only 어댑터는 유지한다.

공통 identity 모듈, 첫 native header 우선, parent-scoped Claude child ID, 전체 sourcePaths 보존, transport ordinal 충돌 방지, streaming snapshot 갱신, 기존 notice 읽음/닫음 이관을 적용했다. 75개 테스트/타입/빌드/native/MCP 통과. 실제 데이터 복사본 및 실행 서버에서 현재 대화 3개 source → 1개 캐릭터, 원래 seat 2, ghost 0을 확인했다. 로컬/Tailscale preview와 macOS 패키지 갱신. 문서는 docs/research/INGESTION-REFERENCE-AUDIT.md 및 골든/공통 규격/아키텍처/고지를 갱신했다.

---

## 2026-10-04 — 공통 관측 규격과 팀 사무실

- 골든 제품 정책과 별도 Office Observation Protocol v1 구현 정책을 정본으로 작성. 공급자 원본 → 공통 실행·관계·이벤트 의미 → 공간/소식 정책 → 장식 동작의 경계를 코드로 분리.
- Codex continuation 파일을 native conversation ID로 병합. 파일 UUID 우선 정책을 교체해 현재 대화의 가짜 두 동료를 제거하고 실제 서브에이전트만 부모 옆에 연결. Claude subagents 경로, OpenClaw parent_session_key 해석도 적용.
- Git common-dir/worktree를 검증해 프로젝트 구분. 확인된 같은 브랜치는 공동 책상, 보조 동료는 작은 책상, 기존 좌석은 유지.
- 비모달 오른쪽 패널, 관계 이동, 대화·소식·작업 정보·메모. 기본 3시간 말풍선, SQLite 미확인 소식, version별 read/dismiss/unread, 새 요청 효과와 장식 휴식.
- 단위 48개, UI 15개 전체 및 최종 스크롤/디자인 수정 후 관련 3개 통과. 네이티브 3종 연결/IPC 소식 저장/미니와 MCP 계약 통과. Git worktree 실제 fixture 검증 포함.
- 로컬/Tailscale 최신 미리보기·macOS arm64 패키지 갱신. 실제 3종 연결, 현재 대화 1개·보조 동료 1개·기존 좌석 2·오염 제목 및 continuation 중복 0개 확인.
- 전체 원본 transcript 백필, 멀티 호스트, 공식 실행/승인 API, 대규모 소식 페이지네이션, 자동 읽음은 후보로 명시. 현재 소식은 수집한 범위 안에서 보존.

## 2026-10-04 — 사무실 메인 UI Ultra Design 9안

- 기존 E 기반 앱을 보존하고 독립 메인 화면 9개와 갤러리·두 안 비교·전체 한눈에 보기 제작.
- 공통 합성 세션 데이터, 고정 좌석, 진행 메시지 우선, 대화형 상세·더보기·접힌 도구 기록·대기/보관 시연.
- Gather, Linear, Kinopio의 공개 화면을 짧게 확인하고 표현 원리와 적용 시안 ID를 카탈로그에 기록. 외부 에셋·라이브러리 도입 없음.
- 전체 9안 브라우저 렌더링과 공통 핵심 동작, 각 페이지·원본 ZIP 및 Tailnet HTTP 200 확인. 제품 코드 변경과 앱 전체 테스트는 이 시안 범위에 없음.
- 원본: public/design/office-themes-2026-10-04/ · 기록: docs/research/design/office-themes-2026-10-04.md.
- 추천 01/04/09는 사용자 선택과 구분하며 실제 앱 적용 전.

## 2026-10-04 — 도구 이름보다 사용자용 진행 설명을 우선 표시

- exec 실행 대신 에이전트가 사용자에게 남긴 진행 설명을 사무실·동료 명단·상세창의 주 정보로 사용. 도구와 시각은 보조로 분리.
- 진행 설명이 없으면 받은 요청, 그마저 없으면 설명 미확인 상태를 표시. 새 턴에 이전 답변을 가져오지 않는다. 완료 답변·오래된 설명은 별도 라벨.
- Codex phase와 공개 메시지 파싱 보강, 내부 분석 제외. 연속 도구 호출 및 짧은 snapshot에도 설명 유지.
- 단위 38개, UI 11개 시나리오 검증(수정한 mock·선택자는 관련 재실행 통과). 화면 실제 렌더링과 독립 리뷰 완료.

## 2026-10-04 — 고정 좌석과 세션 대화 중심으로 핵심 UX 개선

- 기존 좌석을 SQLite에 유지하고 새 세션만 프로젝트 가까운 빈 자리에 배치. 검색·정렬·고정으로 책상을 섞지 않는다.
- 사무실 / 대기 라운지 / 보관 공간. 기본 4시간·7일 자동 이동, 설정 변경, 고정, 복귀 지원.
- 실제 Codex threads.name 및 Claude custom-title / 세션 인덱스 이름 표시. 이름 아래 프로젝트, 최근 활동·앱 열람 빈도 정렬.
- 대화 기본 탭, 사용자·에이전트 말풍선, 길이별 더 보기, 도구 기록 접기, 새 기록 따라가기.
- PR·이슈 실제 링크 카드, 기존 gh 연결로 제목·상태 읽기, 실패 시 미확인 링크 유지.
- 리뷰 후 snapshot tail 이벤트 즉시 병합 보강. 상세 재조회가 실패해도 새 대화가 표시되며 펼친 말풍선과 메모 초안을 보존한다.
- 단위 31개, UI 10개 시나리오(회귀 수정 후 해당 테스트 재실행 포함), 타입/빌드, 네이티브 IPC·미니·MCP 통과. 최신 패키지·실연결 확인은 docs/development/QA.md 참조.
- 커밋 단위 제안: feat 고정 좌석과 세션 생애주기, feat 실제 이름과 실시간 대화·작업 링크. 아직 커밋·원격 PR은 만들지 않았다.

## 2026-10-04 — 현재 Codex 세션이 자는 상태로 표시되던 오류 수정

- 파생 rollout의 부모 session_meta가 세션 ID를 바꿔 현재 기록을 덮어쓰던 문제 수정.
- Codex rollout 파일 UUID와 명시적 adapter ID를 우선하고, 중복은 최신 updatedAt 기준으로 선택.
- fork identity / 최신 중복 회귀 테스트 추가. 총 24개 테스트 및 타입 검사·빌드 통과, 독립 리뷰 확인.
- 실연결 API와 브라우저에서 현재 채팅 세션이 첫 번째 동료·일하는 중으로 표시됨을 확인.
- 로컬/Tailscale 미리보기 재시작, macOS 앱 패키지에도 반영.

## 2026-10-04 — Agent Office 0.1.0 로컬 앱 구현

### 작업 내용

- 시안 E 원본 맵·캐릭터·스프라이트를 보존한 픽셀 사무실과 투명 미니 오피스.
- Claude Code JSONL, Codex JSONL·제목 DB, OpenClaw JSONL·현행 SQLite를 공통 세션/이벤트로 정규화.
- 공급자와 원본 세션 ID를 결합해 충돌 방지. 부분 기록, 출처, 관측/추정, 사용량 미지원 구분.
- 검색, 별명, 고정, 메모, 보관, 수동 결과 확인, revision 검사 인수인계, 읽기 MCP 4종.
- Electron renderer 격리, worker 수집, 로컬 SQLite 저장, macOS arm64 .app 패키지.
- 참고 저장소 6개를 .research에 보관. Pixel Agents의 MIT 경로 탐색을 축소 재사용하고 출처/라이선스 보존.

### 결정과 해결

- 관찰 기록과 사용자 메모를 분리해 원본 변경 시 개인 메모가 유실되지 않게 했다.
- 응답 종료를 업무 완료로, 오래된 로그를 프로세스 종료로 표시하지 않는다.
- OpenClaw 재작성 캐시, 손상된 metadata 격리, 미니 창 복귀 문제를 독립 리뷰 후 수정했다.
- 부가 서버나 모델 호출 없이 동작하도록 수집 worker와 SQLite를 앱에 포함했다.
- 배포 서명/공증과 AI 자동 요약 등은 구현 완료 범위에 포함하지 않는다.

### 검증

단위 22개, UI 6개, 타입 검사/빌드, 네이티브 IPC/미니, MCP 계약 통과. 실제 패키지에서 세 공급자 238개 기록 연결. 상세 근거는 docs/development/QA.md.

### 전달과 후속

- 로컬 소스: ~/projects/agent-office
- 앱: release/Agent Office-darwin-arm64/Agent Office.app
- 사용자 후속 요청으로 Tailscale Serve 4319에 실제 세션 웹 미리보기를 연결했다. HTTPS 응답 및 3종 API 연결 확인. 기존 Serve 경로는 유지했다.
- 원격 저장소·PR·공개 배포는 생성하지 않았다. 프로젝트 전체 상태는 진행중으로 유지한다.
- 커밋 단위 제안: `feat: 실제 세션을 연결하는 픽셀 오피스 구현`, `test: 어댑터 및 데스크탑 회귀 검증`, `docs: 조사 근거와 실행 가이드 기록`. 커밋은 실행하지 않았다.
- 후속 제품 범위와 제한은 README 및 docs/research/RESEARCH.md에 기록했다.

## 2026-10-05 — 첫 PR와 인수인계 문서

- 사용자 선택에 따라 별도 비공개 `kys42/agent-office` 저장소를 만들고 현재 앱 전체를 첫 PR로 정리한다. 기준 `main`은 저장소 초기화만 포함한다.
- `docs/README.md`, `PROJECT-CONTEXT.md`, `SESSION-INGESTION.md`를 추가. 제품 결정·대체된 과거 규칙, 수집 흐름·세 종류의 ID·실패 사례, 직접 사용/정책 이식/자체 구현/조사 전용을 구분하고 고정 커밋·실행 파일·회귀 테스트를 연결했다.
- 골든/아키텍처/조사 문서에서 대체된 페이징 설명과 metadata 예외 읽기 한도를 현재 구현에 맞췄다.
- 실제 대화가 담긴 캡처는 `.local/pr-private-screenshots/`에 보존하고 Git에는 합성 데모 캡처만 넣었다. 장치별 Tailnet 주소를 예시 주소로 교체하고 개인 로그·DB·리서치 clone·빌드 산출물은 제외했다.
- PR 준비 재검증: 단위 88개, UI 18개, 타입/전체 빌드, MCP 4개 도구 계약, 포맷 검사 통과. 문서 로컬 링크 누락 0개. 이 기록의 로컬 결과와 GitHub CI 결과는 별개이며 원격 CI는 PR에서 확인한다.
- PR: https://github.com/kys42/agent-office/pull/1. 첫 구현 `1300bff`의 Linux CI 두 실행 모두 통과. 독립 리뷰에서 수집 정체성·대화/소식·격리 경계·문서 일치성의 차단 이슈 없음. 문서·이미지 마무리 커밋은 최종 PR 체크로 재확인한다.

## 2026-10-05 — 문서 구조 정리

- `docs/golden/`: 프로젝트 맥락, 제품 정책, 플랫폼 공통 관측 규격을 정본으로 모았다.
- `docs/development/`: 아키텍처, 세션 분석, MCP, QA와 초기 구현 계획을 모았다. 초기 계획은 현재 작업 목록과 구분한다.
- `docs/research/`: 레포 조사·모듈 감사와 `design/` 시안 카탈로그를 모았다. 이미지 공용 경로와 원본 `references/`, 런타임 `vendor/`는 유지한다.
- 전체·폴더별 README에 읽기 순서, 문서 역할, 새 문서 분류·채택 기준을 추가했다. 루트 README, 문서 간 링크, vendor 안내, PR 본문과 로컬 문서 인덱스를 새 경로로 연결했다.
- 문서 상대 링크·기존 경로 잔존·diff whitespace를 확인했다. 앱 실행 코드 변경이 없어 로컬 앱 테스트를 반복하지 않는다. 원격 PR CI는 최신 커밋 체크로 확인한다.
