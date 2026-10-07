# 수집·기억·표현 계약

## 하나의 읽기 모델

Electron main → 제한된 preload IPC → 워커 스레드 OfficeService → 공급자별 읽기 어댑터 → OfficeStore(SQLite). 렌더러는 파일·프로세스·Node API에 직접 접근하지 않는다. 정규화된 Session과 Event를 사무실, 상세, 검색, 인수인계, MCP가 함께 사용한다.

- `src/shared/types.ts`: Session, OfficeEvent, Usage, Connector, Preferences의 정본.
- `server/adapters/`: 원본 형식의 차이와 상태 근거를 해석한다.
- `server/store.ts`: 앱의 별명·메모·핀·보관·업무 확인과 원본 관측을 분리한다.
- `server/service.ts`: 5초 폴링, 공급자 오류 격리, 설정·조회 입력 검증.
- `server/worker.ts`, `bridge.ts`: UI를 멈추지 않고 수집·검색을 실행한다. 워커가 죽으면(예: 시작 시 DB 잠김) 대기 중 요청을 실패시키고, 다음 호출(새로고침 등)에서 다시 시작한다. 저장소는 시작할 때 다른 인스턴스의 쓰기 잠금을 최대 수십 초 기다린다(`OfficeStore`).
- `desktop/`: contextIsolation + sandbox + nodeIntegration=false, 메인 프레임·창 검증 IPC. 외부 페이지 내비게이션·새 창·권한 요청은 차단한다.
- `server/mcp.ts`: 같은 SQLite를 readOnly로 열어 4개 조회 도구만 노출한다. 추가 수집기·모델 실행·외부 전송을 시작하지 않는다.

## 지원 소스

| 공급자 | 입력 | 확인하는 정보 |
|---|---|---|
| Claude Code | `$CLAUDE_CONFIG_DIR/projects/**/*.jsonl`, 기본 `~/.claude/projects` | sessionId, message.content, model, cwd, gitBranch, message.usage, 도구 호출·결과, custom-title와 sessions-index 이름 |
| Codex | `$CODEX_HOME/sessions/**/*.jsonl`, session_index.jsonl, state_N.sqlite의 threads(readOnly) | session_meta, turn_context, response_item, task_started/complete, token_count, token_usage_record, 실제 제목 |
| OpenClaw | `$OPENCLAW_STATE_DIR/agents/*/sessions/*.jsonl`, `agents/*/agent/openclaw-agent.sqlite` | JSONL v3; SQLite session_nodes + transcript_events, rewrite watermark |

현재 이 Mac의 OpenClaw는 원본 세션이 SQLite로 이관되어 JSONL 탐색만으로는 동작하지 않는다. DB의 인증·토큰·설정 테이블은 읽지 않는다. SQLite 스키마가 지원 범위와 다르면 연결 오류를 표시하고 마지막 정상 기록을 남긴다. 각 손상된 노드는 독립적으로 실패 처리한다. 재작성 generation을 캐시 revision에 포함한다.

기본 최근 120개/도구, 설정에서 60~300개 선택. 일반 파일 읽기 예산은 3 MiB의 처음·끝이고, 예외적으로 첫 metadata 한 줄은 10 MiB 레코드 한도까지 복구한다. 상세 이벤트는 최근 180개로 제한한다. 수집 범위가 잘렸으면 partial을 표시한다. 파서 회귀 fixture에 실제 개인 원문을 넣지 않는다. 상세 흐름과 출처는 [세션 기록 분석](SESSION-INGESTION.md)을 따른다.

## 상태와 숫자

- 세션은 공급자 + 원본 세션 ID, OpenClaw는 agent 이름까지 포함한 ID로 구분한다.
- 실행 여부를 PID나 CLI 설치 여부로 꾸미지 않는다. 신규 tool call / task_started / task_complete 등은 기록에서 관측한 근거다.
- 최근 실행성 기록이 2분 이상 조용하면 ready(대기 중), 설정한 대기 시간(기본 30분) 이후 idle(쉬는 중), 퇴근 시간(기본 4시간) 이후 sleep(퇴근)으로 파생한다([상태 정책서](../golden/STATUS-POLICY.md)). 무응답으로 원본 세션 종료를 확정하지 않는다.
- 요청 입력 도구의 관측은 `call`; 앱은 승인·답변을 대신 전송하지 않는다.
- `completed`는 사용자가 결과를 확인한 별도 값이다. 턴의 done과 구분한다.
- Codex thread 누적 사용량은 최신 snapshot으로 대체하며 합산하지 않는다. Claude는 동일 message.id의 최대 output 사용량으로 중복을 제거한다.
- 최근 입력량 기반의 문맥 근사치와 세션 누적 사용량은 별도 필드다. OpenClaw의 contextTokens를 실제 사용량으로 오인하지 않는다.
- 누락 값은 null이다. 큰 파일의 Claude 합계는 수집 구간 범위임을 표시한다. 금액은 별도 관측 표본 장부의 API 기본 요금 환산으로 제공하며 실제 청구액과 구분한다. [사용량·작업 위치](USAGE-AND-WORKSPACE.md)를 따른다.

## 렌더러 코어와 표현

큰 사무실 창과 데스크 펫 창은 같은 코드로 같은 코어를 쓰고 표현만 다르다.

- `src/lib/useOffice.ts`: snapshot 구독, 데모 분기, 변경 액션(refresh / setPrefs / patch / receipt / visit / returnToOffice), 15초 시계. `setPrefs`는 저장 성공 여부를 돌려준다.
- `src/shared/office-model.ts`: `buildOfficeModel(snapshot, now)`이 동료 투영, 구역, 좌석 순서, 동료별 `ResidentView`(자세·할 일 그룹·미확인 소식·보조 소식), 그룹별 수, 대표 동료를 한 번에 파생한다. 개인정보 가림과 프로젝트 라벨은 `residentLabel` 한 곳에서 정한다.
- 표현: App/OfficeWorkspace(큰 사무실), DeskPet(접힌 펫), DeskRow(책상 줄). `src/main.tsx`가 `#mini*` 해시로 루트를 고른다.
- 배치: `officeTopology`(구역 → 긴 책상 → 보조 책상)가 좌표 이전의 공통 단계다. `layoutOffice`는 이를 2D 격자로, `layoutRow`는 1D 줄로 투영한다. 말풍선 판단 `stationSpeech`(src/shared/speech.ts)와 `SpeechBubble`·`HelperDesk`·`Furniture`·`Sprite` 컴포넌트, 큰 사무실의 책상 CSS를 두 장면이 함께 쓴다.
- 가리기: `Session.hiddenAt`(`personal` 테이블, 서비스 `veil(ids, on)` 요청이 한 트랜잭션·서비스 시각으로 기록) + `isVeiled`(src/shared/veil.ts). 모델이 `ResidentView.veiled`, `scene`(장면 입력), `veiled`(되돌리기 목록)를 만들고, 액션은 `useOffice.veil(ids, on)`로 공유한다. 펫 말풍선은 `petSummary().speaker`(`PET_FRESH_MS` 2분).
- 말풍선 원문: `snapshotEvents`가 snapshot의 최근 4개 이벤트에 말하는 메시지(activity.eventId)를 더한다. `stationSpeech().markdown`이 원문(코드 블록 제외)을 주고, `InlineMarkdown`(remark-gfm singleTilde off, 인라인 요소만)이 그린다.
- 바닥 책상: `DeskRow variant="floor"`. 같은 `layoutRow`에 `zoneGap: FLOOR_ZONE_GAP`(깃발 자리)을 주고, 장면 높이는 `FLOOR_SCENE_HEIGHT`(책상 발 `DESK_FOOT` + 그림자), 창 높이는 `FLOOR_HEIGHT`. main이 `floor` 모드의 bounds를 정하고, 마지막 펼침 모습은 렌더러 localStorage(`office:dock-expand`)에 둔다.
- 책상 줄은 `ROW_SCALE`(기본 1, 큰 사무실 100%) 고정 축척이며 넘치면 스크롤한다. 창 높이 `ROW_HEIGHT` = 장면 높이 × 축척 + 도구 띠.
- 창 모드(펫/줄)·위치·클릭 통과는 표현 상태라 코어에 넣지 않는다. Electron main이 소유하고 `office:dock` IPC로 렌더러와 맞춘다. 창 기하는 `src/shared/dock-geometry.ts`(순수). 펫 위치만 데이터 디렉터리의 `desk-pet.json`에 저장한다.
- Office.tsx와 Roster.tsx는 애니메이션 시계와 명단 필터 때문에 아직 같은 shared 헬퍼를 직접 호출한다. 결과는 모델과 같다. `ResidentView`로 옮기는 일과 책상 한 칸(`DeskStation`)을 컴포넌트로 묶는 일은 후속이다.

## 보관과 조회

데이터 위치: `~/Library/Application Support/Agent Office/office.sqlite`. `AGENT_OFFICE_DATA_DIR`로 변경할 수 있다. 디렉터리 0700, DB 0600, WAL, busy_timeout. 원본과 사용자 메타데이터를 별도 테이블로 유지한다.

프로젝트 제외·공급자 비활성은 list/search/detail/handoff/MCP 모두에 적용한다. 제외는 조회 정책이며 이미 저장된 데이터의 삭제를 뜻하지 않는다. 개인정보 화면 모드는 화면의 내용을 가리는 기능으로, 원문 삭제·암호화·OS 캡처 차단을 보장하지 않는다.

검색은 제한된 로컬 코퍼스에 대해 대소문자 비구분 AND 부분 문자열을 사용한다. 한국어 부분 단어·기호를 지원한다. FTS5 테이블은 증분 색인으로 유지하되 현재 검색 결과에는 문자열 검증을 사용한다. 의미 검색/AI 요약이라고 표기하지 않는다.

사무실 좌석은 settings의 office_seats에 별도 저장한다. 정렬·검색은 명단에만 적용하며 자리 재배치를 유발하지 않는다. 숫자는 영속 순서 토큰이며 물리 좌표가 아니다. src/shared/office-layout.ts가 프로젝트별 구역, 이어지는 공동 책상, 모든 보조 책상의 실제 좌표를 계산한다. 상태 갱신은 배치를 유지하고 세션 구성·관계·프로젝트·브랜치·창 크기 변경에서만 다시 배치한다. 메인은 층 제한 없이 화면에 모두 맞추며 수동 확대를 지원한다. 기본 4시간 활동이 없으면 대기, 7일이면 보관한다. pinned는 자동 이동에서 제외되고, 수동 archived가 우선한다. 복귀 시 returnedAt을 따로 남기며 원본 updatedAt은 바꾸지 않는다. 열람 횟수는 10초 중복을 제거한 앱 내 열람 수로, 원본 도구 사용 빈도와 다르다.

제목은 사용자 별명 → 원본 이름 → 첫 메시지 기반 제목 순이다. Codex는 threads.name → session_index → threads.title, Claude는 custom-title → optional sessions-index 이름을 사용한다. 대화는 user/assistant 말풍선과 묶은 tool/result 기록으로 표시한다. snapshot의 최근 이벤트를 ID로 병합하고 상세를 다시 읽어, 펼침 상태와 작성 중 메모를 보존하면서 갱신한다.

PR·이슈는 HTTPS GitHub URL만 열 수 있다. 상세를 열 때 최대 8개를 gh api로 조회하고 5분 캐시한다. 조회 실패는 미확인 링크로 남기며 작업 생성·병합을 추론하지 않는다. 메모·대화 전체를 GitHub로 보내지 않는다. 데모와 화면 내용 숨기기에서는 이 조회를 생략한다. MCP는 이 네트워크 조회를 실행하지 않는다.

인수인계는 세션 revision을 검증하고 수동 메모·최근 원문 근거·작업 위치를 Markdown으로 묶는다. 결과 링크는 대화에서 발견한 참고 링크이며 생성·병합의 증거로 승격하지 않는다. 원문 내용을 명령으로 실행하지 않는다. 사용자가 직접 미리보기에서 복사·파일 저장한다.

## 배포와 경계

원래 터미널로 이동·바로 보내기는 `desktop/terminals.ts`(Claude: Orca/tmux)·`desktop/codex-queue.ts`(Codex CLI: 맡은 프로세스가 있는 세션에 `codex queue`)와 main 전용 IPC(`office:terminals`·`office:jump`·`office:send`·`office:terminal-send`)에만 있다. 업무 카드와 말풍선은 같은 훅 `useSendTargets`로 대상을 받는다. 데스크 독의 업무 카드는 별도 창(`#card`, `DockCard`)으로 같은 코어(`useOffice`)와 같은 Inspector를 그리며, IPC `office:card`(열기는 독 창에서만, 닫기·전체 모드는 카드 창에서만)로 연다. 수집기 `OfficeService.call`은 개발 HTTP와 공유되므로 여기에 넣지 않는다. 렌더러는 handle 없는 `TerminalTarget`만 받고, main이 동작마다 다시 찾는다. 보내기는 데스크탑 프로필에만 저장되는 opt-in(켤 때 네이티브 확인창), 쉬는 세션, 터미널 전면을 가진 Claude 프로세스에만 허용한다. 자세한 연결 고리와 경계는 [터미널 연결](TERMINAL.md).

패키지에는 로컬 HTTP 서버를 열지 않는다. 개발용 HTTP는 127.0.0.1:4318로 바인딩, Origin/Host 및 비표준 헤더를 검사하며 Vite에서 프록시한다. Electron 앱에는 수집기 워커와 MCP 번들을 포함한다. 데스크 펫 창은 별도 투명 창이며 입력과 실제 작업 상태를 같은 서비스에서 읽는다. 그려진 요소(`[data-solid]`) 위에서만 마우스를 받고 나머지 영역의 클릭은 뒤 앱으로 통과시킨다(`setIgnoreMouseEvents` forward). 알림 업데이트는 focus를 호출하지 않는다.

서명·공증, auto-update, login item, 다중 모니터/Spaces/Stage Manager 전체 조합 검증, 공식 이벤트 스트림 기반 승인 전달, 토큰 예산 모델 요약/예약, 원격 다중 기기, 장기 Employee/XP 객체는 후속 범위다. 배포 준비 여부와 로컬 기능 검증을 구분한다.

## 사용자에게 보이는 진행 설명

Session.activity는 원본 공개 메시지에서 가져온 220자 이내 발췌, 메시지 종류·시각·eventId와 별도의 최근 도구 이름·시각이다. action은 이 발췌와 같아 검색 결과도 같은 의미를 사용한다. task_started 또는 최근 사용자 메시지를 턴 경계로 삼고, 경계 이후 마지막 assistant 메시지 → 받은 요청 → 기록 상태 순으로 선택한다. Codex commentary/final_answer 및 Claude/OpenClaw stop/tool-use 근거를 공통 phase로 바꾸며 analysis/reasoning은 공개 대화에서 제외한다. 완료/진행 근거가 없는 메시지는 기타 응답으로 남긴다.

도구 호출이 이어져도 공개 진행 설명을 덮어쓰지 않는다. 원본 수집 범위에서 설명을 추출한 뒤 events를 180개로 제한하므로, 도구가 많은 세션과 4개 이벤트만 포함하는 snapshot에도 설명이 유지된다. 2분 넘은 진행 설명이나 작업 중이 아닌 상태에서는 마지막 진행 메시지라는 라벨과 원래 시각을 표시한다. 새로운 요청은 이전 답변을 재활용하지 않는다. 작업 내용을 추론하거나 모델 요약을 생성하지 않는다.

사무실 말풍선은 짧은 발췌, 동료 명단은 두 줄 미리보기, 상세창 상단은 설명과 별도 최근 도구를 표시한다. 원문은 대화 탭에서 읽는다. 화면 내용 숨기기는 발췌·툴팁·도구 상세에도 적용한다.


### 수집 모듈 출처

JSONL decoding은 `vendor/orca/runtime/session-scanner-jsonl-reader.ts`를 `server/adapters/files.ts`에서 bounded read stream으로 사용한다. `identity.ts`가 provider identity를 공통 관계로 바꾸며 Codex origin은 vendored Orca 함수를 호출한다. Claude 중첩 경로/sidecar/title 정책은 Agent Sessions 이식이다. OpenClaw SQLite는 기존 read-only 전용 어댑터를 유지한다. 전체 비교와 의존성 선택: [INGESTION-REFERENCE-AUDIT.md](../research/INGESTION-REFERENCE-AUDIT.md).

### 현재 Git과 기록 Git의 분리

`Session.branch`/`gitCommit`은 원본 기록이다. `server/workspaces.ts`는 Git common-dir/worktree와 함께 symbolic-ref, rev-parse HEAD를 읽기 전용으로 조회하여 `WorkspaceIdentity.git`에 branch/commit/state/observedAt을 채운다(15초 캐시). `branchInfo`는 검증된 최근 실행 위치가 있으면 그 worktree의 현재 브랜치를 먼저 표시한다. 그 외에는 기록 이름/커밋을 우선하고, 없는 경우만 현재 checkout을 출처와 함께 표시한다. detached HEAD와 비 Git 폴더를 미확인 브랜치 하나로 뭉치지 않는다. 화면은 공급자에 무관한 공통 정보를 사용한다.

### 대화와 소식 분류

`src/shared/conversation.ts`가 OfficeEvent의 공개 단계에 따라 사용자 요청/진행/최종/미분류/도구를 나누고 중복 공개 이벤트를 정리한다. Conversation은 이 기준으로 종류 필터와 말풍선 라벨을 적용하며 도구 기록은 기본 숨긴다. 분류를 바꿔도 메시지 확장 상태를 보존한다.

소식 저장 범위와 중요 알림 범위는 별도다. `src/shared/notices.ts`의 중요 소식 selector는 완료 phase가 있는 reply와 미해결 attention/error만 반환한다. 모든 배지와 snapshot.noticeStats.unread가 같은 selector를 사용한다. NewsFeed는 최종/확인/전체 필터, 읽은 항목 포함, version별 일괄 read를 공유한다. 오래된 phase 없는 reply는 수집 시 본문/시각이 동일한 경우만 읽음 상태를 보존하며 분류를 보완한다. 그 외 오래된 기록은 전체에 남아 있으며 완료로 추측하지 않는다.
