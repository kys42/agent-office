# 오피스 매니저 — 전담 tmux 세션

2026-10-18 로컬 구현. MCP를 등록하거나 기존 작업 세션을 매니저로 전환하지 않는다. 사무실·데스크톱 한 줄/깃발뷰의 **오피스 매니저 프로젝트**에 일반 동료처럼 앉는다. 같은 말풍선과 대화 카드에서 메시지를 보내며 **매니저 설정**에서 Codex 또는 Claude Code를 선택하고 **매니저 출근**을 누른다. 선택한 CLI의 기존 로그인을 사용한다.

## 사용

- 준비물: Node 24 기반 앱, `tmux`, 로그인된 `codex` 또는 `claude` CLI. 앱은 PATH, `~/.local/bin`, Homebrew 경로와 알려진 Codex 앱 경로에서 실행 파일을 찾는다.
- 매니저는 별도의 작업 공간과 새 대화로 시작한다. 후속 요청은 저장된 **그 매니저의 ID**로만 이어간다. `--last`, `--continue`, 기존 작업 세션 선택을 사용하지 않는다.
- “로그인 작업하던 동료 찾아줘”, “지금 나 기다리는 동료 있어?”, “이 동료 QA 구역으로 옮겨줘”를 요청할 수 있다. 대상 동료는 이름이나 작업으로 요청하면 매니저가 조회한다.
- **지금 요약**으로 즉시 브리핑을 받는다. 설정에서 1–24시간 간격 또는 매일 시각을 저장할 수 있다. 기본은 요청할 때만이며, 자동 요약을 임의로 켜지 않는다.
- 예약은 Office가 실행 중이고 매니저가 출근한 동안 작동한다. Mac의 로컬 시간대를 따른다. 앱을 종료할 때 출근 상태였다면 다음 실행에서 재연결하고, 놓친 여러 주기는 한 번의 요약으로 모은다. 잠든 Mac을 깨우는 OS 예약 작업은 아니다.
- **매니저 퇴근**은 실행 중인 요청과 대기열을 중지한다. 완료된 대화와 요약은 남는다. 앱 종료·프로세스 실패로 중단된 요청은 자동 재실행하지 않는다.
- 공급자는 퇴근한 상태에서 바꾼다. 변경하면 새 공급자의 전담 대화를 시작하며 이전 브리핑 기록은 유지한다.

## 공통 동료 동작과 매니저 구역

- `office:manager`는 공급자와 무관한 영속 세션 ID다. `office:manager-project` 프로젝트에 배치하고 기존 Office/DeskRow/DeskPet의 책상·말풍선·선택·소식·읽음/닫기·핀·검색·메모·북마크·팝업 고정·초안을 공유한다. 완장과 세이지색 책상(`furniture.manager-reception.v2`)만 역할을 구분한다. 이름과 외형, 구역 배치도 일반 동료처럼 바꿀 수 있다.
- `projection.ts`가 전담 요청을 일반 사용자/진행/완료 이벤트로 바꾸고 trusted worker 경로로 OfficeStore에 저장한다. 전체 공급자 재수집이 매니저를 지우지 않으며 기존 personal 설정과 소식 receipt를 유지한다. 실행 완료 전에는 최종 답변으로 표시하지 않는다.
- 실제로 소유한 native ID만 영속 저장해 수집기 중복 표시를 제외한다. 매니저 ID는 선택한 CLI 공급자 수집을 꺼도 남고, 프로젝트 제외 정책은 그대로 적용한다. 이름이나 폴더로 다른 세션을 추정하지 않는다.
- 매니저 전송은 일반 입력창에서 전담 요청 대기열로 연결한다. tmux 안의 runner는 일반 TUI가 아니므로 키 입력이나 `codex queue`를 사용하지 않는다. 이전 native ID로 들어온 전송도 같은 경로로 연결한다.
- 역할 UI는 같은 카드 안의 **지금 요약 / 동료 상태 / 매니저 설정**이다. 전용 채팅 화면이나 별도 고정 런처를 두지 않는다.

## 공통 에이전트 패턴 적용

private `agent-web-guide`의 조회(Query)·동작(Action)·표현(Display) 분리를 적용한다. 조회 결과를 전부 자동 렌더링하지 않고 매니저가 `show_agents` 또는 `show_briefing`을 호출하면 검증된 서비스 데이터만 대화 카드로 저장한다. 동료 카드는 열 때에도 제외 정책을 다시 검사한다. 북마크는 당시 카드와 본문을 함께 보존한다. 임의 HTML/JS/URL 실행은 없다.

데스크톱에서는 기존 IPC와 snapshot push를 재사용한다. 별도 HTTP/SSE 서버를 열지 않는다. 공개 assistant 메시지, 도구 진행, 타입이 정해진 카드를 진행 이벤트로 갱신하고 provider 완료 신호 뒤에 최종 답변을 기록한다. 토큰 단위 스트리밍이나 provider의 비공개 추론 노출을 뜻하지 않는다.

## 연결 구조

```text
일반 Inspector/말풍선 → Electron 전용 IPC → OfficeManager
                                      ├─ 상태·대화·예약 저장
                                      ├─ 전용 tmux 서버/세션 → runner → codex exec / claude -p
                                      └─ 로컬 Unix socket ← ./office 명령 ← 전담 스킬
                                              ↓
                                       기존 OfficeService
```

- `skills/office-manager/SKILL.md`가 스킬 정본이다. 빌드에 포함하고 출근 시 전담 작업 공간의 `.agents/skills/office-manager`와 `.claude/skills/office-manager`에 설치한다. 사용자의 전역 스킬/MCP 설정은 수정하지 않는다.
- `server/manager/controller.ts`: 요청 직렬화, tmux 수명, 로컬 인증, 저장 및 예약. `runner.ts`: 같은 대화로 CLI를 호출하는 단일 실행기. `provider.ts`: 공급자별 명령과 JSONL 결과 해석. `actions.ts`: Office의 허용된 조회/배치 동작. `cli.ts`: `./office`의 JSON 인터페이스.
- tmux는 별도 `-L ao-manager-<profile hash>` 서버와 `office-manager-<profile hash>` 세션을 쓴다. 앱마다 분리하며 사용자의 다른 tmux 세션을 조회·중지하지 않는다. 요청 사이에는 runner만 대기하고 모델은 실행하지 않는다.
- Codex는 `exec --json --ignore-user-config`, 후속은 `exec resume <manager ID>`를 사용한다. 사용자 MCP를 자동 연결하지 않으며 인증은 CLI에 맡긴다. Claude는 `-p --output-format stream-json --verbose`, 후속은 `--resume <manager ID>`를 사용하고 명시적 빈 MCP 설정을 전달한다.
- Codex의 workspace-write 실행은 Office socket 접근을 위해 network access를 허용한다. 승인 우회 플래그를 사용하지 않는다. 이 스킬은 모델의 역할 지침이며 OS 수준의 완전한 격리는 아니다.
- 번들 runner/CLI는 ASAR 밖의 전담 디렉터리에 복사한다. Electron의 Node 모드로 실행하므로 패키지 앱에서 별도 Node 설치를 요구하지 않는다.

## 도구와 상태 경계

`./office help`에서 인수를 확인한다. `overview`, `news`, `search`, `detail`, `zones`, `handoff`는 읽기, `show_agents`/`show_briefing`은 검증된 표시 카드 생성이며, `move`, `return`, `pin`, `focus`는 사용자 요청에 따른 사무실 동작이다. 다른 에이전트에게 메시지 전달, 권한 승인, 실제 작업 폴더 이동은 이번 구현에 없다.

`overview`는 관측 시각·수집 상태·동료 상태와 소식을 반환한다. 소식은 제한된 화면 snapshot 대신 영속 `noticePage`를 사용하며 `moreNotices`와 `nextBefore`로 이전 페이지를 읽는다. 원문이 긴 소식은 발췌임을 표시한다. 수집된 범위에서 못 찾은 기록을 존재하지 않는다고 단정하지 않는다.

구역 이동은 `managerMove` 서비스에서 최신 사용자 규칙을 읽어 **해당 세션의 규칙만** 변경하고 snapshot을 발행한다. 기존 `sendToZone`을 사용하며 다른 세션의 규칙·실제 Git 위치는 변경하지 않는다. 프로젝트 제외·공급자 비활성 정책은 기존 조회/수정 서비스에서 유지된다.

요약은 broker에서도 읽기 명령만 허용한다. 다음 요약의 시작점은 성공한 이전 요약의 **시작 시각**이며, 실패하면 옮기지 않는다. 요약 중 도착한 소식을 다음 번에 포함한다. 중복 요약 대기열은 막고 예약 시각이 지나면 다음 시각으로 이동한다. 실패한 요청의 즉시 자동 재시도는 없다.

## 저장·알림

Office 데이터 디렉터리 아래 `manager/state.json`에 설정, 전담 대화 ID, 최근 요청/결과 100개와 예약 시각을 원자적으로 저장한다. `manager/workspace`는 매니저의 전담 cwd다. 세션 자체의 원문은 각 CLI가 관리한다. 다른 동료의 원문을 별도 장기 기억으로 복사하지 않는다.

디렉터리 0700, 연결 정보·상태 0600, 임시 socket 디렉터리 0700을 사용한다. runner 인증과 요청별 CLI 인증을 분리하고 요청 완료/중지 시 CLI 인증을 폐기한다. TCP/HTTP 포트나 원격 서버를 열지 않는다. 같은 OS 사용자 권한으로 실행되는 CLI에 대한 보안 격리 경계는 아니다.

요약 완료/실패는 선택한 알림 설정에 따라 네이티브 알림으로 알린다. 원문은 알림에 넣지 않는다. 내용 숨기기는 매니저 대화·입력창도 가리며 기존 정책처럼 저장 삭제나 모델 접근 차단을 뜻하지 않는다. 데모/웹 미리보기에서는 실제 매니저를 실행하지 않는다. 매니저의 제어와 대화는 로컬 데스크톱 범위이며 LAN export와 모바일 공유 목록에서는 제외한다. tmux/Unix socket 기반이라 Windows 네이티브 실행은 지원하지 않는다.

## 검증

- `npx tsx --test tests/manager.test.ts tests/manager-projection.test.ts`: 공통 세션·소식·북마크·재시작·중복 제외·표시 도구, 구역 보존·제외 정책·요약 읽기 제한, 예약 시각, provider 실패, 실제 tmux/CLI 연결·재개·인증 폐기·종료·예약 복구. tmux가 없으면 tmux 통합 사례만 skip. 테스트 자체가 runner를 임시 번들로 빌드하므로 앱 빌드 전에도 실행 가능하다.
- `npx playwright test tests/ui/manager.spec.ts`: 공통 카드·프로젝트 구역·출근·예약 설정·대화·실패한 초안 보존·검증된 상태 카드·데모 격리, 작은 팝업의 Enter 전송·닫기 후 초안 복원.
- `npm run build && node scripts/manager-desktop-smoke.mjs`: 실제 Electron IPC, Electron Node 모드, tmux, CLI helper를 연결하고 합성 provider 응답으로 검증. 사무실/깃발뷰 팝업 전송, 초안 복원, 고정, 이전 native ID 전송도 확인한다. tmux 필요.
- 실제 Codex 인증으로 공통 팝업에서 조회 요청 전송·응답을 확인했다. 추가로 합성 사무실 조회, 같은 전담 세션 재개, QA 구역 생성·이동, 영속 소식 조회 기반 요약을 확인했다. Claude는 프로토콜/오류 처리를 검증했으나 이 맥에 CLI가 없어 로그인된 실제 실행은 미검증이다.

이 검증은 로컬 개발 범위다. 설치 앱 교체, 패키지 배포, 외부 CI·PR·병합은 포함하지 않는다.
