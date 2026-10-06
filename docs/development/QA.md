# 데스크 펫·책상 줄과 코어 공유 · 2026-10-06

- 단위/계약 **121개** 통과. 신규 테스트:
  - `tests/office-model.test.ts`: 큰 사무실과 같은 투영·좌석 순서, 명단과 같은 할 일 그룹, 펫 대표 우선순위, 보조 동료의 background 오류가 펫을 부름, 페르소나 멤버 → 자리 주인, 개인정보 라벨
  - `tests/office-row.test.ts`: 큰 사무실과 같은 구역·책상·좌석 토폴로지, 긴 책상과 구역 겹침 없음, 보조 책상이 긴 책상을 끊지 않음, 말풍선 판단(소식 우선·3시간 만료·소식이 있으면 진행 문장 숨김)
  - `tests/dock-geometry.test.ts`: 줄 bounds, 펫 기본·저장 위치, 화면 밖 복귀, 축척 clamp
  - 기존 `office-layout` 6개는 토폴로지 분리 후에도 그대로 통과
- Playwright **33개** 통과. 신규: 900px 폭에서 책상 164px 유지·오른쪽 화살표로 넘김·←로 복귀·도구 띠가 말풍선 위. 미니 테스트를 교체했다: 헤더 → 펫(기다려요) → 6개 책상이 같은 높이 한 줄, 여러 구역·공동 책상·말풍선·소식 표시, 전체 폭·하단 맞닿음 → Esc/접기 → 캐릭터 클릭 시 큰 사무실 상세 → `#mini=row` 직접 열기. 큰 사무실의 기존 시나리오는 말풍선/보조 책상 컴포넌트를 분리한 뒤에도 변경 없이 통과했다.
- Electron smoke: 펫 창(작은 크기·항상 위) → 펼친 뒤 창 x·폭이 작업 영역과 같고 하단에 맞닿음 → 접으면 원래 자리 → 큰 사무실 복귀, 렌더러 격리. 임시 `--user-data-dir`로 실행해 이미 떠 있는 Agent Office의 단일 인스턴스 잠금과 분리했다. 9회 중 첫 1회가 실패했는데 출력이 잘려 원인을 확인하지 못했다. 이후 8회는 연속 통과했다.
- TypeScript·formatter·production build, MCP smoke 통과. 문서 이미지 [데스크 펫](../images/desk-pet.png)과 [책상 줄](../images/desk-row.png)은 합성 데모 기록만 사용했다.
- 리뷰 반영(독립 세션 + Codex):
  - 보조 동료의 확인 요청이 펫·카운트에서 빠지던 문제
  - 같은 모드로 다시 띄울 때 클릭 통과 캐시가 남던 문제
  - 책상 칸의 투명한 부분이 클릭을 가로채던 문제
  - 창 모드 기준을 main으로 일원화, 로드 직후 모드 재전송
  - 연결 오류 표시, 드래그 중 재배치 건너뜀, 창 생성 시 `show:false`, 미확인 소식 인덱스를 1회만 계산
- 자동화로 확인하지 못한 것: 실제 마우스 드래그 이동, OS 수준 클릭 통과(forward), 다중 디스플레이 전환. 수동 확인 대상이다.

# UX 재설계(할 일 흐름) · 2026-10-05

- 단위/계약 **107개** 통과(신규 `tests/triage.test.ts` 6개: 돌아온 시점으로 고정한 요약 구간, 할 일 그룹 순서, 진행/읽음/보조·단계 불명 응답 제외, 페르소나 실행의 미해결 질문 승격, 관측된 작업 시작 기반 경과 시간, 자리 비운 사이 요약의 bootstrap/읽음/이전 수신 제외).
- Playwright **32개** 통과(신규 `tests/ui/ux.spec.ts` 9개: 한글 입력 상태의 물리 키 단축키와 입력칸 Esc, 공간 단축키 재적용 방지, 할 일 명단·숫자 이동, 지금 카드의 재개/읽음, 팔레트의 동료·명령 실행과 순위, J/K/R·도움말·입력 중 무시와 읽음 후 커서 고정, 패널 탭, 스포트라이트 시 가구 좌표 불변, `page.clock`으로 자리 비운 사이 요약).
- 1280×720에서 대화 영역 240px 계약을 지키도록 지금 카드·헤더·하단 버튼의 짧은 창 모드 추가. 390px overflow 없음.
- TypeScript·formatter·production build, Electron smoke(3종·미니·IPC·격리), MCP smoke(4개 읽기 도구) 통과.
- 독립 리뷰 반영: 요약 구간 고정·0건 자동 해제, 페르소나 실행 전체 기준의 지금 카드/R, R은 확인 요청 제외, `e.code` 기반 단축키, 공간 요청 1회 적용, 명단과 같은 J/K 그룹 내 순서, 팔레트 로딩 정리, 동료 전환 시 펼침 초기화, 미니/로딩 중 ⌘K 무시, 패널 전환을 버튼 그룹으로. 기존 Modal 포커스 재설정·입력 중 Esc 패널 닫힘도 수정.
- 실제 로컬 기록에서 미확인 최종 응답이 많은 경우 모든 동료가 ‘확인할 결과’로 묶이고, 요약 숫자는 겹치는 사실(일하는 중 포함)로 표시되는 것을 확인.

# 퇴근·보관 설정과 보조 자리 수명 · 2026-10-05

- 단위/계약 101개 통과. 기간 경계·자동 보관 끄기·핀/수동 보관 우선순위·잘못된 설정 조합의 API 거부·저장 재개 검증.
- 보조 응답 직후 유지 → 도구/폴링에는 유지 → 부모 새 요청에서 접힘 → 상세 결과 계속 접근. 중첩 부모·미수집 부모·메인 대기·진행 중/확인 필요 예외·새 보조 요청 재참여를 검증.
- 220개 도구 이벤트 이후에도 부모의 taskStartedAt을 보존하며 fragment merge/compact snapshot/재수집에서 경계가 회귀하지 않음.
- Playwright 전체 실행 22개 통과 후 새 설정 테스트의 native option matcher를 toHaveJSProperty(disabled,true)로 정정하고 해당 1개 재실행 통과. 실제 옵션의 disabled 속성은 처음부터 정상. 합계 23개 시나리오 확인.
- 설정의 일 단위 선택·보관 끄기·복귀 시 요약·대기 역전 방지·390px overflow 없음. 합성 캡처는 .local/office-settings-lifecycle.png.
- TypeScript 포함 production build, formatter, Electron(IPC/미니/격리) 및 MCP(4개 읽기 도구/검색/인수인계) smoke 통과. 변경 diff 읽기 리뷰에서 새 중·고위험 회귀 없음.

# 동료 투영·소식 열람·에셋 확장 검증 · 2026-10-05

- 단위/계약 테스트 **96개**, Playwright **21개**, TypeScript 포함 production build, formatter 통과.
- Electron smoke: 3종 세션·미니 모드·IPC 영속성·renderer isolation 통과. MCP smoke: 읽기 도구 4개·검색·인수인계·오래된 revision 거절 통과.
- 추가 회귀: 최신 진행 우선, X 이후 과거 말풍선 재생 방지, version별 열람/읽음/접기, 재시작 복원, OpenClaw 페르소나 대표 교체와 안정 좌석, SQLite optional cron 메타데이터, cross-persona key 관계, 최신 fragment의 메타데이터 누락, 일반 guardian 이름과 내부 origin 구분.
- UI: 페르소나 실행 선택이 실제 세션 상세로 연결되고 한 자리만 강조됨. 내부 실행은 접힌 기록에서 접근. 라운지 침대/펫 에셋·프로젝트 이름표, 390px 화면 overflow 없음. 작업 중 표식과 휴식 구분, 명시적 열람 배지 확인.
- 합성 데모 캡처를 docs/images에 갱신. 실제 화면은 .local에만 보관. 실서버 확인 당시 canonical 234개 → 표시 동료 37명, 접힌 보조 82개. OpenClaw 120개 실행 → 페르소나 5명. 수집 제한/시간에 따라 변하는 관측값이며 제품 상수 아님.
- 로컬 production preview 4319의 화면/API 200, 세 공급자 연결, 실제 화면 JS 오류 0. Tailscale Serve HTTPS/API는 노드 IP를 지정하고 정상 인증서 검증을 유지한 요청으로 200 확인. 이 컴퓨터의 일반 DNS 조회는 ENOTFOUND여서 기본 DNS 경로의 외부 접속 성공으로 주장하지 않음. OS DNS 설정은 변경하지 않음.
- 범위 한정 독립 읽기 리뷰에서 추가 고위험 회귀 없음. 내부 링크 116개 확인. 색상/소품 편집 및 영구 꾸미기 저장 UI는 아직 범위 밖이며 확장 계약만 구현.

# 첫 PR 검증 · 2026-10-05

[PR #1](https://github.com/kys42/agent-office/pull/1), 첫 구현 커밋 `1300bff` 기준으로 로컬 단위 88개·UI 18개·전체 빌드·포맷·MCP·Electron smoke가 통과했다. GitHub Actions의 Node 24 / Ubuntu에서도 포맷·단위·빌드·MCP·UI 검증을 통과했다. UI의 실제 로컬 기록 연결 1개는 CI에서 제외하며 나머지는 합성 fixture를 사용한다.

독립 읽기 전용 리뷰에서 identity/continuation, phase/receipt, renderer/HTTP 경계, CI 이식성, 새 프로젝트 맥락·세션 분석 문서를 확인했고 차단 이슈는 발견되지 않았다. 개인 실기록과 캡처는 Git에서 제외하고 데모 이미지로 갱신했다. 이후 문서·이미지 보완 커밋의 CI는 PR 체크를 기준으로 확인한다.

---

# 대화 분류·중요 소식 검증 · 2026-10-05

- `npm test`: **88/88 통과**. 공통 대화 분류, 서로 다른 phase의 같은 문장 보존, Claude/Codex/OpenClaw 완료/진행 근거 매핑, 중요 소식 숫자, 기존 phase 없는 소식의 읽음/접기 보존, 스트리밍 최종 전환, 버전 경합, observed-only cursor의 재분류 시 과거 소식 재생성 방지 포함.
- `npm run test:ui`: **18/18 통과**. 실제 3종 연결을 포함한 기존 16개 + 대화 종류 전환/확장 보존/도구 기본 숨김/실시간 필터 유지, 진행 20개를 제외한 최종+질문 2건 배지/분류별 일괄 읽음/읽은 기록 재표시 검증. 스크롤 배치·보관 발췌 보완 뒤 전체 재실행 통과. 마지막 필터 위치 조정 후 관련 4개 시나리오 재검증 통과.
- 현재 수집 구간 밖 최종 응답은 저장된 소식에서 보완하되 보관된 발췌·원문 일부 라벨을 표시. 원본 이벤트가 돌아오면 중복 없이 전체 원문을 우선하는 회귀 테스트 통과.
- 1280×720에서 PR 카드가 있는 업무 카드의 대화 스크롤 영역이 240px 이상이고 필터가 화면에 보이는지 검증. 390px 모바일 가로 넘침 없음.
- 타입 검사·웹/Electron/MCP 빌드 통과. native 3종/미니/IPC persistence/isolation, MCP 4개 read-only 도구/search/handoff 계약 통과. macOS arm64 패키지 갱신.
- 실제 preview에 반영. 확인 시 전체 소식 기록과 별개로 중요 미확인 배지는 21~22건(새 실제 응답에 따라 변동), 3종 235세션 연결. 기존 미확인 124건을 자동 읽음/삭제로 줄인 것이 아니라 공통 중요 소식 selector로 표시 범위를 줄였다. 동일 시각/본문인 기존 기록의 receipt 변경 0건. 실제 과거 receipt는 모두 미확인이어서 읽음/접기 이관 증거는 합성 store 재시작 테스트가 보완한다.
- 분류 보완 초기에 observed-only 과거 메시지가 전체 기록에 다시 나타나는 경로를 확인해 cursor 버전 전환 회귀 테스트를 추가했다. 수정 후 과거 관측만 있던 메시지의 분류 변경으로 새 소식을 만들지 않는다. 완료 여부 불명 응답은 중요 배지에 포함하지 않는다.
- 골든 정책 v3와 공통 관측 규격 갱신. 원본 미지원 단계는 기타 응답으로 보존하고 최종 응답을 추측하지 않음. `error` kind의 원본 매핑은 기존과 같이 예약 상태이며 일반 도구 오류를 최종 실패 알림으로 바꾸지 않는다.

---

# 동적 가구·브랜치 표시 검증 · 2026-10-04

최신 실행 코드 기준. 아래 이력과 구분한다.

- `npm test`: **81/81 통과**. 기존 수집/정체성/소식 계약 + 희소 좌석 토큰, 활동 갱신 배치 안정성, 1/7/24/120개 주 세션과 5개 보조 세션의 구역 겹침·누락 검사, 실제 Git named/detached/unborn fixture, 기록/현재 Git 우선순위와 커밋 수집 회귀.
- `npm run test:ui`: **16/16 통과**. 18개 주 세션 + 보조 4개를 모두 화면 내부에 배치, 프로젝트 구역/책상/의자 DOM 확인, 폴링 순서 변경과 상세창 개방 시 가구 좌표 유지, 확대→전체 보기, 390px 모바일 가로 넘침 없음. 기존 소식/대화/검색/미니/개인화/실제 3종 수집 테스트 포함.
- `npm run build`: 타입 검사, 웹·Electron·MCP 번들 통과.
- `npm run test:desktop`: 3 provider, mini, IPC persistence, renderer isolation 통과.
- `npm run test:mcp`: 4 read-only tools, search/handoff, stale revision 거부 통과.
- `node scripts/package.mjs`: macOS arm64 패키지 갱신. 기존 optional `.icon` 경고만 있음.
- preview 재시작 후 실제 RPC: 총 235개 기록, Claude 4 / Codex 111 / OpenClaw 120 모두 connected. 당시 사무실 주 세션 7개 + 보조 3개가 메인 화면 하나에 표시됨. 시간 경과·실제 활동에 따라 현재 인원은 달라진다.
- TaskDeck 2f06/836c worktree는 실제 detached HEAD이며 원본 branch=null, gitCommit=7b880ba…와 현재 HEAD가 일치. 화면 `HEAD · 7b880ba` 확인. 이름이 있는 다른 작업은 원본 main 표시. 원본과 Git checkout은 변경하지 않음.
- 로컬 4319 실제 브라우저 확인, Tailscale HTTPS 4319 HTTP 200. 실제 대화가 포함된 브라우저 캡처는 로컬 `.local/pr-private-screenshots/office-dynamic-v2.png`에만 보관. 18+4 밀도 fixture는 `.local/dynamic-office-dense.png`.
- 전체 보기는 모든 동료가 보이는 것을 우선하므로 인원이 많을수록 이름/말풍선이 작아진다. 확대와 명단/오른쪽 상세를 함께 제공한다. 미니 창은 실제 주 동료 최대 6개이며 메인 제한과 다르다.

---

# 수집 모듈 재사용 검증 · 2026-10-04

- `npm test`: **75/75 통과**. 기존 48개 + Orca 원본 origin suite 17개 + ingestion conformance 10개.
- `npm run typecheck`, `npm run build`, 최종 backend `npm run build:desktop`: 통과.
- `npm run test:desktop`: 3 provider fixture, mini, IPC persistence, renderer isolation 통과.
- `npm run test:mcp`: 4 read-only tools, search, handoff, stale revision 거부 통과.
- `node scripts/package.mjs`: macOS arm64 패키지 갱신. 기존 optional .icon 형식 경고 외 실패 없음.
- 원본 DB는 read-only backup으로 임시 복제한 뒤 새 수집기로 replay. Claude 4 / Codex 111 / OpenClaw 120, 모두 connected. 현재 대화는 source 3개 → canonical 1개, 기존 seat 2 유지, 문제의 continuation ghost 0개. 두 번째 refresh에서 notice 수 증가 없음(75 → 75). 당시 실제 읽음/닫음 receipt는 0개였으므로 receipt 이관 증거는 합성 회귀 테스트에 한정한다.
- 실행 중 preview를 새 backend로 재시작 후 실제 RPC에서도 같은 source 3 → 1, seat 2, ghost 0과 세 플랫폼 연결 정상 확인. 로컬/Tailscale HTTPS 페이지 모두 HTTP 200.
- UI 레이아웃 변경은 없어서 이번에는 전체 UI 15개를 재실행하지 않았다. 이전 UI 결과는 아래 과거 기록이며 이번 native IPC/snapshot 검증과 구분한다.
- 초기 대형 header 복구 테스트에서 공유 FileHandle을 Node stream iterator가 닫는 EBADF를 발견. bounded async byte generator를 주입해 수정했고 해당 재현 포함 전체 테스트가 통과했다.
- 외부 모듈 원본, 커밋, 라이선스, 실제 도입/이식/제외 범위: [수집 레퍼런스 감사](../research/INGESTION-REFERENCE-AUDIT.md).

---

# 로컬 검증 기록 · 2026-10-04

대상: Agent Office 0.1.0, Apple Silicon macOS, Electron 44.5.1. 로컬 실행 산출물 검증이며 서명·공증된 외부 배포 검증은 아니다.

| 검증 | 결과 |
|---|---|
| 단위·회귀 테스트 | 31개 통과 |
| Playwright 화면 테스트 | 10개 시나리오 통과 |
| TypeScript / 프로덕션 빌드 | 통과 |
| 네이티브 Electron | 3종 fixture 수집, IPC 저장, 미니 창 복귀, renderer 격리 통과 |
| MCP stdio | 읽기 도구 4개, 검색, 인수인계, 오래된 revision 거부 통과 |
| 패키징된 .app 실연결 | Claude 3 / Codex 120 / OpenClaw 120, 총 243개. 세 공급자 connected |
| 의존성 감사 | npm audit 취약점 0개 |
| Tailscale 미리보기 | HTTPS 4319 응답 200, 같은 origin의 RPC 및 3종 실제 세션 연결 확인 |

세션 수는 2026-10-04 후속 핵심 UX 검증 관측값이며 실행 중 바뀔 수 있다. OpenClaw는 최근 120개 한도다. 패키지 시작부터 첫 수집 완료까지 이번 측정은 4.6초였다. 이후 변경분을 캐시하고 5초 간격으로 확인한다. 최초 UI에는 저장된 세션이 먼저 표시될 수 있다.

## 화면 확인

- 1440×970: 사무실·좌석·명단·하단 상태를 확인.
- 390×844: 가로 넘침 없음.
- 840×218: 투명 미니 창, 6개 책상, 원래 사무실로 복귀.
- 이름 편집, 메모 저장, 검색, 도구 필터, 내용 숨기기, 수집 중지, 움직임 줄이기, 인수인계 미리보기 검증.
- 문서 이미지에는 합성 데모 기록만 사용했다. [사무실](../images/office.png), [업무 카드](../images/detail.png), [미니](../images/mini.png), [대기 라운지](../images/waiting.png).

## 독립 리뷰에서 보강한 부분

1. OpenClaw transcript 재작성 시 seq가 유지되어도 rewrite watermark로 캐시 무효화.
2. 손상된 세션 메타데이터 한 건이 다른 세션 수집을 중단하지 않도록 격리.
3. 미니 창에서 큰 창으로 복귀하면 미니 창을 숨기고, 창 재생성 시 로드 후 선택 전달.

## 핵심 UX 후속 검증

- 좌석: 정렬·필터·고정·새 세션 유입·저장소 재시작으로 기존 번호 유지. 같은 프로젝트 빈 자리 우선.
- 생애주기: 기본 4시간 대기 / 7일 보관, 고정·복귀·설정 변경 검증. 수동 열람은 원본 활동 시각을 바꾸지 않음.
- 이름: Codex native name 우선순위와 Claude custom-title / index fixture 검증. 현재 채팅은 에이전트 사무실로 확인.
- 대화: 사용자/에이전트 분리, 독립 더 보기, 새 이벤트 수신, 상세 재조회 실패 시 tail 병합, 미저장 메모 유지, 최신 대화로 스크롤 검증.
- GitHub 카드: 허용 URL·실제 href·외부 열기 격리 검증. 공개 Codex 이슈 읽기로 실제 제목 및 closed 상태 조회 확인. 데모 예시 링크는 별도 표시.
- 단위 31개 통과. UI 10개 중 신규 회귀의 mock 참조 공유 오류를 고쳐 해당 테스트 재실행 통과, 스크롤 보강 후 관련 2개 재실행 통과.
- 네이티브 3종 fixture / IPC / 미니 창 / renderer 격리 및 읽기 MCP 계약 통과. 최신 패키지 실수집 243개 확인.

## 재현

```bash
npm test
npm run test:ui
npm run build
npm run test:desktop
npm run test:mcp
npm run package
node scripts/package-smoke.mjs
npm audit
```

`package-smoke.mjs`와 실제 연결 UI 테스트는 이 Mac의 기록을 읽는다. 나머지 핵심 테스트는 임시 합성 fixture를 사용한다. CI 설정은 추가했지만 아직 원격 저장소에서 실행하지 않았다.

## 남아 있는 범위

2026-10-04 후속 실사용 수정: 파생 Codex rollout에 포함된 부모 metadata 때문에 세션 ID가 충돌하고 오래된 중복이 최신 기록을 덮어쓰던 문제를 수정했다. 파일 UUID/명시적 ID를 정본으로 유지하고 최신 updatedAt을 가진 중복을 선택한다. 현재 작업 세션이 고정 좌석에서 표시되며 `일하는 중`으로 갱신됨을 실제 API와 브라우저에서 확인했다. 독립 리뷰에서도 추가 중·고위험 문제 없음.

서명·공증·자동 업데이트, Windows/Linux 패키지, 장시간 메모리/전력 측정, 공식 hook 기반 실제 승인·프로세스 제어, 모델 요약·의미 검색·예약 회고는 별도 검증과 구현이 필요하다. 패턴 기반 비밀값 가리기는 모든 비밀정보 제거를 보장하지 않는다. 프로젝트 제외는 조회 정책이며 원본/저장 데이터 삭제가 아니다.

최종 미리보기 재시작 후 기존 사무실 좌석 번호 보존을 API로 확인했다. 현재 채팅 이름 에이전트 사무실 / 작업 중 / 기존 좌석 2 유지. 로컬 4319와 Tailscale HTTPS는 최신 빌드로 제공한다.

진행 설명 후속 개선: 단위 38개 통과(신규 7개), UI 11개 시나리오 검증. 신규 UI mock에 설정 저장 동작을 추가하고 다중 노출된 문구 선택자를 대화 영역으로 한정한 뒤 관련 2개 재실행 통과. 공개 메시지 우선, 연속 도구 호출 후 유지, 새 턴 분리, 오래된 설명 라벨, 내부 분석 제외, 개인정보 모드 확인. 사무실·상세 스크린샷 갱신, 독립 리뷰에서 추가 고위험 문제 없음.

최종 실제 연결: 243개 세션에 activity 생성 확인. 현재 Codex 채팅의 방금 사용자용 진행 메시지가 주 설명으로, exec가 보조 도구로 표시되며 기존 좌석 2 유지. 브라우저에서도 진행 설명 카드 확인. 로컬/Tailscale 최신 빌드 및 macOS 패키지 갱신.


## 2026-10-04 — 공통 관측 v1 / 공간과 소식

이전 파일 UUID 우선 방침은 폐기하고 native 대화 소유 메타데이터로 교체했다. continuation은 한 대화로 합치고 실제 fork/subagent는 독립 관계로 보존한다. 현재 대화의 두 continuation ID가 독립 세션 목록에 없고 원래 제목 `에이전트 사무실`, 기존 좌석 2, 실제 보조 동료 1개가 연결됨을 재시작한 API에서 확인했다.

- 단위 48/48: 3종 어댑터, continuation/분기/상속 이력, ambient wrapper 제외, 같은 입력의 공통 상태, unknown branch/worktree 구분, 순환·누락 부모, SQLite 소식 bootstrap·스트리밍 버전·read/dismiss·재시작, 실제 Git worktree의 공통 저장소 키.
- UI 15/15: 기존 11개 시나리오 + 도킹 영역 분리·배경 동료 클릭·모바일 쌓기, 말풍선 접기와 미확인 보존, 공동/보조 책상과 부모 이동, 새 요청 효과의 bootstrap/폴링 중복 방지. 최종 소식 탭 스크롤과 버튼 스타일 수정 후 관련 3개 재실행 통과.
- 타입/프로덕션 빌드 성공. Electron 3종 fixture, 소식 read/dismiss IPC, 미니 창, 렌더러 격리 통과. 읽기 전용 MCP 4개 계약 통과.
- 실제 연결: Claude 4, Codex 111, OpenClaw 120개 기록. 원본 소스를 읽기 전용으로 확인. 오염된 in-app-browser-context 제목 0, 확인한 continuation 가짜 ID 0.
- 로컬 4319 / Tailscale HTTPS 200, 최신 arm64 앱 패키지 생성. 시안 테마 갤러리는 보존.
- 독립 리뷰를 새로 실행한 것은 아님. 이번 별도 위임은 읽기 전용 세션 관계 조사 1건이며 본체가 구현·테스트·화면 검수했다.

구현 계약과 남은 후보는 GOLDEN-OFFICE-POLICY.md / OFFICE-OBSERVATION-PROTOCOL.md를 정본으로 본다.

최종 소식 탭에서는 반복 요약을 생략하고 하단 동작을 한 줄로 정리했다. 관련 공개 진행/편집·인수인계/소식 UI 3개를 추가 재실행해 통과했다. 실제 대화가 포함된 최종 화면은 로컬 `.local/pr-private-screenshots/office-policy-v1.png`에만 보관.
