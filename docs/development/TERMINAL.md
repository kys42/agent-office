# 원래 터미널로 이동·바로 보내기

[골든 정책](../golden/GOLDEN-OFFICE-POLICY.md) · [아키텍처](ARCHITECTURE.md) · [문서 지도](../README.md) · 이슈 [#8](https://github.com/kys42/agent-office/issues/8)

업무 카드에서 확인한 Claude Code 세션이 지금 Orca나 tmux 터미널에 떠 있으면, 그 탭/패널로 바로 이동하고 쉬는 중일 때 후속 입력을 보낸다. 데스크탑 앱 전용이다. 웹 미리보기와 MCP에는 없다.

## 세션에서 터미널까지

정본 `desktop/terminals.ts`. 모든 단계는 검증에 실패하면 "터미널 없음"으로 끝나고 기존 동작(재개 명령 복사)을 쓴다.

1. **세션 → 프로세스.** Claude Code가 쓰는 `${CLAUDE_CONFIG_DIR:-~/.claude}/sessions/<pid>.json`에서 `sessionId`가 같은 기록을 찾는다. 문서화되지 않은 CLI 상태라 `pid`·파일명 일치, `sessionId` 형식, `procStart`/`status` 존재, `kind: interactive`를 모두 확인한다. 살아 있는 pid라도 `TZ=UTC LC_ALL=C ps -o lstart=`가 `procStart`와 다르면 재사용된 PID로 보고 버린다. 같은 세션 기록이 여럿이면 최근 `updatedAt`부터 본다.
2. **프로세스 → 호스트.** `ps -wwE`(인수+환경)에서 `ps -ww`(인수)를 잘라낸 나머지만 환경으로 읽는다. 인수 속 `ORCA_TERMINAL_HANDLE=…` 같은 글자는 무시된다. 값은 엄격한 정규식(`term_…`, `%숫자`, 절대 경로 소켓)만 허용한다. 환경변수는 상속되므로 **pty 소유자**로 진짜 호스트를 정한다. 부모를 따라 올라가며 같은 tty를 쓰는 동안 계속 오르고, 처음으로 다른 tty(또는 없음)에 있는 조상이 그 pty를 연 프로그램이다(`ps -axo pid,ppid,tty,comm`). 환경과 소유자는 프로세스 수명 동안 바뀌지 않아 `pid:procStart`로 캐시한다.
   - **tmux**(`TMUX`, `TMUX_PANE`)가 직접 호스트이므로 먼저 본다. 소유자가 tmux 서버이고 `tmux -S <socket> display-message -t <pane> '#{pane_tty}…'`의 tty가 같아야 인정한다. tmux 표식이 있는데 확인이 안 되면 **대상 없음**이다. Orca 안에서 띄운 tmux는 바깥 Orca 핸들을 물려받지만, 그 탭은 다른 패널이나 셸을 보여 줄 수 있다.
   - **Orca**(`ORCA_TERMINAL_HANDLE`, `ORCA_TAB_ID`)는 소유자가 `Orca.app` 프로세스이고 `orca terminal show --json`이 connected·writable·not orphaned·같은 `tabId`여야 인정한다. Orca 탭 안의 screen·zellij·nvim `:terminal`에서 띄운 Claude는 핸들을 물려받아도 소유자가 달라 제외된다. 라벨은 탭 제목이다. 탭 제목만으로 매칭하지 않는다(실측에서 제목과 세션 이름이 다른 경우가 있었다).
3. **렌더러에는 `TerminalTarget { kind, label, status, canSend }`만** 보낸다. handle·소켓·pane은 넘기지 않고, main이 이동·보내기마다 다시 찾는다. 조회는 3초 캐시, 이동·보내기는 캐시 없이 새로 확인하고 보낸 뒤 캐시를 지운다.

Codex는 기존 `codex://threads/<id>` 열기를 유지한다. Codex app-server는 rollout 파일을 열어 두지 않아 pid 매핑 근거가 없다. Ghostty·Warp·VS Code 내장 터미널 등 위 두 호스트 밖에서 실행한 세션은 이동·보내기 대상이 아니다.

## 이동

업무 카드의 재개 버튼이 대상이 있으면 "Orca로 이동"/"tmux로 이동"이 된다(`office:jump`).

- Orca: `orca terminal switch --terminal <handle>` 후 `open -a Orca`로 앱을 앞으로 가져온다.
- Orca가 `navigated: false`를 돌려주면 이동 실패로 알린다.
- tmux: `select-window`·`select-pane`, 다른 tmux 세션을 보는 클라이언트를 위해 `switch-client`(클라이언트가 없으면 무시). 어느 터미널 앱이 그 tmux에 붙어 있는지는 추적하지 않는다.
- 대상이 없으면 기존 동작: Codex 링크 열기, 그 외 재개 명령 복사.

## 바로 보내기 (opt-in)

설정 **터미널로 보내기**(기본 꺼짐)를 켜면 업무 카드의 지금 카드 아래에 입력창이 생긴다(`TerminalSend.tsx`, ⌘↵). 꺼져 있으면 실행 중이라는 안내 한 줄만 보인다.

- **opt-in은 데스크탑 프로필에만 있다.** 공유 `Preferences`가 아니라 Electron `userData/terminal-send.json`(0600)에 저장하고 IPC `office:terminal-send`로만 읽고 바꾼다. 웹 미리보기는 켤 수 없다(공유 스키마가 `terminalSend`를 거부, 테스트로 고정). 켤 때는 main이 **네이티브 확인창**을 띄우고, 렌더러가 대신 확인할 수 없다.

- **입력 그대로.** 그 터미널에 사용자가 직접 친 것과 같다. 기록에 실제 사용자 메시지로 남고 수집기가 그대로 다시 읽는다. 권한 확인 없이 띄운 세션이면 그대로 실행된다는 점을 설정에 적었다.
- **쉬는 중일 때만.** 프로세스 `status === 'idle'`일 때만 보낸다. `busy`(작업 중)·`shell` 등에서는 거부한다. 승인 프롬프트에 글자가 들어가 승인으로 처리되는 일을 막는다. 보낸 직후 카드는 작업 중으로 표시하고, 쉬는 상태로 돌아올 때까지 화면에 보이는 동안만 4초마다 다시 확인한다.
- **터미널 앞에 있을 때만.** Ctrl+Z로 멈춘 Claude는 기록이 `idle`로 남은 채 셸이 앞으로 나온다. 보내기 직전 `ps -o stat,pgid,tpgid`로 멈춤(`T`)이 아니고 Claude의 프로세스 그룹이 터미널 전면 그룹인지 확인한다. 그렇지 않으면 셸 명령으로 실행될 수 있어 거부한다(실측: Ctrl+Z → 거부, `fg` → 다시 보내기 가능).
- **평문만.** `\n`·`\t` 외 제어문자(ESC, BEL, C1 등)를 제거하고 trim, 1~4000자.
- Orca: `orca terminal send --terminal=… --text=… --enter --wait-submit=5 --json`. `--flag=값` 형식이어야 `--`로 시작하는 글도 값으로 읽힌다. `result.send.accepted`가 아니면 `refusedReason`과 함께 알리고(거부 시 CLI가 0이 아닌 코드로 끝나도 출력을 읽음), `prompt.stages`에 `turn_started`가 있으면 "작업이 시작됐어요"로 알린다.
- tmux: 고유 이름 버퍼에 **stdin으로** `load-buffer`(인수로 넘기면 끝의 `;`를 tmux가 명령 구분자로 먹음) → `paste-buffer -p -d`(bracketed paste라 줄바꿈이 조기 제출되지 않음, 실패하면 버퍼 삭제) → 150ms 후 상태·전면 소유를 **다시 확인**하고 `send-keys Enter`. 그사이 작업이 시작됐으면 Enter를 누르지 않는다.
- 결과를 확인하지 못한 실패(시간 초과 등)는 "보냈는지 확인하지 못했어요"로 알린다. 글이 이미 들어갔을 수 있어 그대로 다시 보내라고 하지 않는다.

## 경계

- IPC `office:terminal`·`office:jump`·`office:send`는 `desktop/main.ts`에만 있다. `OfficeService.call`(개발 HTTP `/api/rpc`와 공유)에는 없어 웹 미리보기·Tailscale로는 도달할 수 없다. 테스트로 고정했다.
- opt-in은 main이 데스크탑 프로필 파일에서 매번 확인한다. 공유 설정·웹 미리보기와 무관하다.
- 외부 명령은 shell 없이 `execFile`과 인수 배열, timeout·출력 한도로 실행한다. `orca`·`tmux`는 Finder 실행의 좁은 PATH를 고려해 고정 경로 후보에서 찾는다.
- 로그·DB·렌더러에 handle과 입력 내용을 남기지 않는다. 보낸 내용은 원본 세션 기록에만 남는다.

## 쓰지 않는 방법

조사 근거는 이슈 #8 본문과 댓글에 있다.

- Claude Code 세션 간 메시지 소켓(`messagingSocketPath`, `<pid>.<hash>.key`): 문서화되지 않은 내부 프로토콜이고 토큰을 읽어 세션 간 권한 경계를 외부 앱이 우회하게 된다.
- tty 장치 쓰기(출력만 됨), TIOCSTI(macOS에서 root 필요), `claude -p --resume`(열린 세션과 대화가 갈라짐), 키 입력 흉내(포커스 탈취·손쉬운 사용 권한).
- 터미널과 무관한 실행 래퍼(pty 직접 소유)는 미검증 후보다.

## 알려진 한계

- 입력창에 아직 제출하지 않은 초안이 있으면 보낸 글이 그 뒤에 이어 붙어 함께 제출된다(설정 설명에 안내).
- Orca 경로는 상태 확인과 제출 사이를 Orca가 처리하므로, 그 짧은 사이에 턴이 시작되는 경우는 막지 못한다. tmux는 Enter 직전에 다시 확인한다.
- 셸 없이 tmux 패널의 첫 프로세스로 `claude`를 띄우면 Ctrl+Z가 실제로 멈추지 못한다(작업 제어 없음). Claude 화면만 일시정지 안내가 되고 입력은 셸 없이 tty에 찍힐 뿐 실행되지 않는다.
- 첫 조회는 전체 프로세스 표와 Orca CLI 때문에 기기 부하에 따라 1~2초 걸린다. 이후에는 Orca 약 0.5초, tmux 수십 ms.
