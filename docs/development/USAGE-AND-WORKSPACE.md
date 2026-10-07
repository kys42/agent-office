# 사용 한도·관측 비용·실행 위치

[골든 정책](../golden/GOLDEN-OFFICE-POLICY.md) · [문서 지도](../README.md)

## 계정 한도

상단 **사용량** 버튼은 오른쪽 패널을 연다. 사무실은 그대로 보이며 동료 상세·소식함과 한 자리만 사용한다. 현재 로그인 계정의 남은 비율과 갱신 시각이다. 세션 토큰/모델 문맥/실제 청구액과 다르다. 두 창 모두 오는 경우 5시간·일주일을 표시하고, 한 창만 오면 그것만 표시한다. `primary`가 반드시 5시간이라는 가정을 하지 않고 기간 값을 읽는다. Codex의 복수 limit ID도 독립 표시한다. null/실패/미지원은 0%가 아니다.

정본 `server/quotas.ts`: 버튼 요청에서만 실행, 60초 메모리 캐시, 동시 요청 결합, 실패도 잠시 캐시. 수집 폴링·MCP에서 실행하지 않는다. 공급자 비활성은 조회하지 않는다. 데모는 합성 값, 개인정보 모드는 조회·숫자 표시를 생략한다. 최신 계정을 다시 로그인했다면 캐시 최대 1분 후 반영된다.

- Codex: `app-server` 프로세스에 initialize/initialized → `account/rateLimits/read`만 전송한다. 대화/모델 실행을 만들지 않는다. 타임아웃·1MiB 응답 한도, 성공/오류/종료 모두 SIGTERM 후 필요시 SIGKILL. raw stderr는 버린다. macOS 설치 앱의 bundled CLI가 있으면 우선 사용하고 그 외 PATH CLI를 쓴다. 이 Mac의 npm launcher가 누락된 바이너리를 가리키는 문제에서 앱 번들 경로를 검증했다.
- Claude: 기존 `.credentials.json`의 `claudeAiOauth.accessToken`, 기본 macOS 설정이면 `Claude Code-credentials` Keychain 항목을 읽는다. 해당 토큰을 issuer의 고정 `https://api.anthropic.com/api/oauth/usage`에만 전송한다. redirect 금지·10초 timeout. 쿠키 수집, 인증 갱신/변경, 모델 요청은 하지 않는다. credential은 프로세스 메모리에만 존재하며 DB/renderer/로그에 복제하지 않는다. OS의 기존 키체인 접근 정책은 그대로 적용된다.
- OpenClaw: 여러 모델 연결의 실행 플랫폼이라 통합 구독 한도를 가정하지 않는다. 미지원 설명을 표시하고 실행별 비용은 일반 장부를 사용한다.

## 세션 비용 장부

정본 `server/pricing.ts`, `normalize.ts`, `store.ts`. `usage_ledger(session_id, entry_id, data)`에 관측 표본을 저장한다. 개인 메모/읽음 영수증과 별도이며 실제 원본은 수정하지 않는다. snapshot/detail에는 집계 `Session.cost`만 전달한다.

Claude/OpenClaw는 message ID별 최대 출력 표본, Codex는 native response ID와 `token_usage_record.usage`가 우선이다. 구버전의 `token_count.last_token_usage`는 cumulative snapshot key로 중복을 제거한다. cumulative 총량 자체를 돈으로 반복 합산하지 않는다. native 기록이 나타나면 같은 세션의 fallback 표본은 제외해 두 포맷을 이중 계산하지 않는다. 따라서 포맷 전환 때 표시 금액이 보정될 수 있다. 비용 표본의 변경도 revision에 반영한다. 최근 구간만 재수집해도 기존 장부는 유지하고, streaming의 작은 값이 완전한 표본을 덮어쓰지 않는다.

`UsageEntry.input`은 캐시 read/write를 제외한 입력이다. Codex input에서 cached/write를 빼며 Claude는 원본이 분리한 입력을 사용한다. cache creation은 5분/1시간을 분리하고 TTL이 없으면 기본 5분으로 환산한다. 알려진 모델만 계산하며 날짜형 모델 suffix만 정규화한다. 임의 내부 별칭을 비슷한 공개 모델로 매핑하지 않는다.

표시는 **관측 누적 · API 기본 요금 환산**이다. 구독 사용자의 실제 결제액이 아니며, 수집 전/파일 중간 누락 구간·모델 요금 미확인은 제외한다. 현재 요금표의 표준 기본 단가를 동일하게 적용하는 작업량 척도다. Fast/장문 할증·지역·이미지/검색 등의 도구 요금·할인은 반영하지 않는다. 정확한 청구서나 원본 전체 비용이라고 부르지 않는다. 원본 재작성/삭제가 장부의 과거 관측을 자동 삭제하지 않는다. 요금표 변경 시 파서 캐시 버전도 갱신해 재집계한다.

2026-10-05 확인한 공식 출처: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing), [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing). 단가는 코드의 versioned 표가 정본이다.

## 실제 작업 위치

원본 `cwd`/`branch`/`gitCommit`은 보존한다. `workingLocation`은 가장 최근 명시적 shell workdir/cwd 또는 literal leading `cd … &&` 관측과 시각/출처다. `WorkspaceIdentity.locationSource`는 그 관측을 실제 Git 경로로 검증했다는 연결이다. 이 경우 현재 worktree의 branch/HEAD가 책상 표시를 이끈다. Git common-dir는 기존처럼 같은 프로젝트의 worktree를 한 팀으로 묶는다.

Codex functions.exec 안의 `tools.exec_command`는 Acorn으로 구문만 읽는다. 실행하거나 문자열을 eval하지 않는다. literal 인수만 허용하고 동적 경로·함수 정의·조건부 호출·다른 위치의 병렬 호출은 추측하지 않는다. Claude Bash와 OpenClaw exec도 같은 중간 규격으로 번역한다. 파일 읽기 인수, 경로가 언급된 진행 문장, PR URL만으로는 이동하지 않는다. PR은 다른 저장소의 참고 링크일 수 있다.

Git 검증이 실패하면 시작 위치의 팀을 유지하고 상세에 관측 경로만 남긴다. partial tail에서 경로 관측이 빠지면 이전 경로와 당시 Git 근거를 함께 보존한다. 실제 shell 실행 성공, remote host, 동적으로 조합한 shell 변수, 여러 동시 작업 위치는 모두 완전히 추적할 수 있는 것이 아니다. 상세에서 관측 시각을 확인할 수 있다.

## 서류 도착과 집중 연출

서비스가 받은 지 15초 안이고 요청 자체도 75초 안에 보낸 내 요청이면 서류 도착과 요청 발췌('내 요청' 말풍선)를 보여준다(`freshRequest`). 화면별 '본 것' 기억이 없는 순수 판단이라 큰 사무실·책상 줄·바닥 책상·펫이 같다. 과거 기록(bootstrap)·백그라운드 실행·접은 요청은 제외하고, 부르는 중·오류인 동료는 말풍선과 자세를 그대로 둔다. 연출이 끝나면 최신 공개 소식 표시로 돌아가며 요청 자체는 대화에 남는다. 가장 최신 요청을 선택한다.

최근 실행 기록이 있고 현재 요청/턴 시작 경계를 아는 동료만 5분 뒤 집중, 15분 뒤 몰입, 30분 뒤 불타는 중 연출을 쓴다. 경과 시간은 요청 이후의 벽시계 시간이며 실제 연속 CPU 작업 시간/생산성 점수가 아니다. 오래 조용해짐·응답 완료·입력 대기에는 꺼지고 다음 요청에서 다시 시작한다. 모션 감소/백그라운드 탭은 애니메이션을 멈춘다. 공유 presentation 계약만 사용하며 공급자별 UI 상태 분기를 추가하지 않는다.

## 참고 코드와 재사용 결정

확인한 로컬 checkout:

- Orca `ea6a6d60774ac2b74bb6692d1798e3ab13b99ae0`: `src/main/rate-limits/claude-oauth-usage-request.ts`, `codex-rpc-rate-limit-probe.ts`. 읽기 API·handshake·타임아웃/종료·기간 분리 방식을 참고했다. Electron net/proxy·자체 process manager 등 의존성이 많아 원본 모듈을 그대로 추가하지 않았다.
- Agent Sessions `b7893c772b0014918211f1c45a5ab58add229703`: `ClaudeOAuthTokenResolver.swift`, `ClaudeOAuthUsageClient.swift`, `CodexCLIRPCProbe.swift`. 기존 credential 위치·read-only probe 경계를 교차 확인했다. Swift 앱을 runtime dependency로 가져오지 않았다.

이번 quota/cost/workspace 구현은 위 계약을 참고한 자체 TypeScript 모듈이다. 기존 Orca JSONL/origin vendor는 계속 사용하며 새 vendor 원본 복사는 없다. 추가 runtime dependency는 JavaScript 구문 읽기를 위한 MIT `acorn`뿐이다. 통합 앱 전체 복사보다 작은 공통 `ProviderQuota/UsageEntry/WorkingLocation` 경계를 유지한다.

회귀 검증은 `tests/usage-workspace.test.ts`, `tests/ui/usage-life.spec.ts`와 기존 ingestion/store/UI 테스트에 있다. 실제 인증값이나 대화는 fixture에 넣지 않는다.
