# 내장 터미널 호스트 (1단계 #385, 2단계 #401)

tmux나 Orca 없이 앱이 에이전트 터미널을 띄우고 백그라운드에서 유지하기 위한 작은 데몬입니다. 1단계는 데몬, 프로토콜, 앱 쪽 클라이언트까지입니다. 2단계(#401)에서 앱이 이것을 실행 행선지·실행 위치·답장 대상으로 씁니다([앱에서 쓰기](#앱에서-쓰기-2단계-401)).

## 구조 (`desktop/term-host/`)

| 파일 | 역할 |
| --- | --- |
| `daemon.ts` | 진입점. `dist-desktop/term-host.cjs`로 번들되고 앱 실행 파일을 Node로(`ELECTRON_RUN_AS_NODE=1`) 띄워 detached로 돕니다. |
| `host.ts` | 세션·클라이언트·요청 처리. 소켓과 node-pty 없이 테스트할 수 있게 분리했습니다. |
| `session.ts` | PTY 하나, 그 헤드리스 화면, 붙은 화면별 출력 대기열, 종료와 kill. |
| `screen.ts` / `modes.ts` | `@xterm/headless` + serialize 스냅샷, 스냅샷에 담기지 않는 입력 모드·스크롤 영역·커서 추적과 복원 시퀀스. |
| `escape-tail.ts` | 스트림이 걸쳐 있는 미완성 escape 시퀀스·UTF-8 글자 바이트. |
| `protocol.ts` | 프레이밍, 메시지 타입, `restoreSequence`. |
| `endpoint.ts` | 소켓·토큰 경로, 0700 디렉터리, 0600 토큰, 소켓 소유권 게시. |
| `client.ts` | 메인 프로세스용 타입 있는 클라이언트와 `connectTermHost`(붙거나 없으면 띄우기). |
| `fakes.ts` | 테스트용 가짜 PTY, 메모리 안 연결 쌍, 가짜 호스트. 앱·데몬은 가져오지 않습니다. |

## 프로토콜

- 프레임은 `[kind u8][길이 u32 BE][본문]`입니다. kind 1은 JSON 제어 메시지, kind 2는 `[세션 id 길이 u8][id][원본 바이트]` 데이터입니다.
- 데이터를 NDJSON에 넣지 않은 이유: 터미널 출력은 ESC가 많아 JSON에서 바이트당 최대 6배가 되고, base64는 1/3이 늘고 청크마다 인코딩·디코딩이 듭니다. 길이 접두는 바이트를 그대로 나르고, 헤더만 보고 너무 큰 프레임을 본문 버퍼링 전에 거절합니다(hello 전 4KB, 이후 16MB).
- 요청은 `hello`(프로토콜 버전 + 토큰), `create`, `list`, `attach`, `detach`, `screen`, `resize`, `kill`, `shutdown`입니다.
- `screen`(프로토콜 2)은 지금 보이는 화면을 줍니다: 행별 글자(오른쪽 공백은 `tmux capture-pane -p`처럼 잘라 냄), 행별 흐린 글자(SGR 2) 범위 `[시작, 끝)`(UTF-16 기준, 넓은 글자의 둘째 칸은 더하지 않음), 커서, 대체 화면 여부, 프로그램이 정한 창 제목(OSC 0/2). 그때까지의 출력이 파싱된 뒤 읽고, 동기화 출력(2026) 중이면 attach처럼 최대 100ms 기다립니다. 끝난 세션은 `exited`입니다. 입력(write)은 응답 없는 데이터 프레임이고 같은 연결의 다른 메시지와 순서가 유지됩니다.
- 이벤트는 출력(데이터 프레임), `exit`, 그리고 느린 클라이언트용 `snapshot`(resync)입니다.
- `attach`는 스냅샷과 모드 시퀀스를 돌려주고 그다음 출력부터 실시간으로 보냅니다. 새 xterm에는 `restoreSequence(result)`를 쓰면 됩니다(동기화 출력 2026으로 감싸 한 번에 그립니다).

## 화면 복원

- serialize 스냅샷만으로는 TUI가 깨집니다(Superset #541). 그래서 `modes.ts`가 스트림에서 모드를 추적해 스냅샷 뒤에 다시 켭니다. 대상은 bracketed paste 2004, focus 1004, 마우스 9/1000/1002/1003과 인코딩 1005/1006/1015/1016, 커서 키 1, 키패드 66, 커서 표시 25, kitty 키보드(`CSI > u` push/pop/set, 화면별 스택), origin·insert·wraparound입니다.
- kitty 키보드는 맨 위 값만이 아니라 스택 전체를 push로 다시 쌓습니다. 그래서 이후 pop이 원래 터미널과 같게 동작합니다. 대체 화면이 떠 있으면 일반 화면의 스택은 스냅샷이 대체 화면으로 넘어가기 전에 쌓습니다.
- 대체 화면(47/1047/1049)은 serialize가 직접 전환합니다.
- 스크롤 영역(DECSTBM)은 xterm 내부 버퍼 값을 읽어 다시 설정합니다. 영역 설정이나 origin 모드는 커서를 맨 위로 보내므로, 그 뒤에 커서를 원래 자리(origin 모드면 위 여백 기준)로 되돌립니다.
- 스냅샷은 출력 청크 번호에 맞춰 찍습니다. 요청 시점까지 파싱이 끝난 다음 찍고, 그 화면에 이미 들어간 대기 청크는 버리므로 빠지거나 두 번 보이는 출력이 없습니다.
- 출력이 escape 시퀀스나 UTF-8 글자 중간에서 끊긴 시점에 스냅샷을 찍으면, 그 미완성 바이트를 첫 출력으로 보냅니다(`escape-tail.ts`, Orca의 pending escape tail과 같은 이유). 그래야 다음 청크가 `1mRED`처럼 글자로 찍히지 않고 시퀀스를 마칩니다. 64KB를 넘는 미완성 문자열은 버립니다.
- 프로그램이 동기화 업데이트(2026) 중이면 최대 100ms 기다렸다가 찍습니다.
- JSON으로 8MB를 넘는 스냅샷(색이 아주 많은 긴 히스토리)은 히스토리를 절반씩 줄여 최신 부분만 보냅니다. 프레임 상한(16MB) 때문에 연결 전체가 끊기지 않게 하려는 것입니다. 보이는 화면만으로도 넘으면(아주 큰 창에 칸마다 다른 색) 속성 없는 글자와 커서 위치만 보냅니다.
- 클라이언트는 attach 응답 바로 뒤에 온 출력·종료·resync를 매크로태스크 하나만큼 붙잡아 둡니다. `await attach()` 한 쪽이 스냅샷을 먼저 그리게 하려는 것입니다.

## 흐름 제어

- PTY 읽기는 멈추지 않습니다. 커널 버퍼가 차면 에이전트가 멈추기 때문입니다.
- 붙은 화면이 없으면 헤드리스 화면에만 넣고 아무것도 보내지 않습니다.
- 그 출력 속의 질의(커서 위치 `ESC[6n`, 장치 속성 등)에는 헤드리스 화면이 답해 PTY로 돌려줍니다. 답이 없으면 기다리다 멈추는 프로그램이 있기 때문입니다. 출력을 받는 화면이 하나라도 있으면 그 화면(2단계의 xterm)이 답하고 헤드리스는 답하지 않으므로, 답이 두 번 가지 않습니다. 기준은 청크를 파싱하는 순간 그 청크를 실시간으로 받을 화면이 있는지입니다. 스냅샷을 기다리는 화면은 그 청크를 스냅샷 안에서 받으므로 질의를 보지 못합니다. 이때는 헤드리스가 답합니다.
- 클라이언트의 입력은 1MB 단위 프레임으로 나눠 보냅니다. 큰 붙여넣기도 프레임 상한에 걸리지 않습니다.
- 붙어 있으면 4ms 단위로 묶어 세션당 프레임 하나로 보냅니다.
- 소켓에 512KB 넘게 쌓이면 쓰기를 멈추고 `drain`을 기다립니다. 그동안 한 화면의 대기열이 4MB를 넘으면 버리고, 소켓이 비면 새 스냅샷(`snapshot` 이벤트)을 보냅니다.
- 스냅샷을 찍는 사이에 상한을 넘기면, 그 스냅샷 뒤에 한 번 더 새 스냅샷을 보냅니다.
- 이렇게 밀린 화면이 있는 채로 세션이 끝나면, 종료 이벤트 전에 마지막 화면을 보냅니다.
- xterm은 비동기 파싱이 50MB 밀리면 예외를 냅니다. 그 전에(32MB) 화면 반영만 건너뛰고 `droppedBytes`로 셉니다. 측정에서는 0이었습니다.

## 수명과 소켓 소유권

- 앱 데이터 디렉터리 아래 `term-host/`(0700)에 토큰(0600, 64자 hex)과 로그를 둡니다.
- 소켓은 `term-host/v<프로토콜>.sock`입니다. 경로가(먼저 bind하는 더 긴 사설 이름 기준으로) 100바이트를 넘으면 `/tmp/agent-office-term-host-<uid>/<해시>/`를 쓰고, 이 디렉터리는 소유자와 권한을 확인만 하고 고치지 않습니다.
- Windows는 사용자와 데이터 디렉터리로 키를 만든 named pipe를 씁니다.
- 프로토콜 버전이 소켓 이름에 들어가므로 새 앱은 새 데몬을 띄우고 옛 데몬은 자기 세션을 유지합니다.
- `connectTermHost`는 붙어 보고, 소켓이 없거나 거절되면 데몬을 한 번 띄운 뒤 붙을 때까지 재시도합니다. 데몬이 종료 중이면 hello를 거절하고 클라이언트는 다음 데몬으로 재시도합니다.
- 소켓 게시는 Orca의 데몬 규칙(AGENTS.md)을 따랐습니다.
  - 비공개 이름(`.p<hex>`)에 bind하고 `link`로 공개 이름을 차지합니다.
  - 이미 있으면 접속해 보아, 거절되거나 없을 때만 죽었다고 봅니다. 시간 초과나 권한 오류는 아무것도 증명하지 않으므로 물러납니다.
  - inode를 다시 확인하고 한 번 더 접속해 본 뒤 `rename` 한 번으로 바꿉니다.
  - 종료하는 데몬은 공개 이름을 지우지 않습니다.
  - 그래서 앱 두 개가 동시에 데몬을 띄워도 하나만 게시하고 나머지는 종료 코드 20으로 끝납니다.
  - 게시가 확정될 때까지는 hello를 거절합니다. 경쟁에서 진 데몬이 세션을 만들어 버리고 사라지는 일이 없습니다.
  - POSIX에는 compare-and-swap rename이 없습니다. 그래서 같은 죽은 소켓을 둘이 동시에 교체하면 둘 다 rename할 수 있습니다. 교체한 쪽은 200ms 뒤 다시 확인하고, 이름을 빼앗겼으면 물러납니다.
  - 그보다 늦게 빼앗긴 데몬은 2초마다 하는 확인에서 알아챕니다. 그때부터 새 hello와 create를 거절하고, 남은 세션이 끝나면 종료합니다.
- 클라이언트는 hello에도 남은 시간(최대 3초)을 적용합니다. 받기만 하고 답하지 않는 리스너에 묶이지 않습니다.
- 세션도 클라이언트도 없으면 60초 뒤 종료합니다. 끝난 세션의 종료 정보와 마지막 화면은 5분 보존하고, 그동안은 종료를 미룹니다.
- kill은 프로세스 그룹에 SIGHUP을 보냅니다. 3초 안에 안 끝나면 SIGKILL을 보내고, 리더가 끝난 뒤에도 그룹을 SIGKILL로 한 번 더 쓸어 남은 자식을 없앱니다. Windows는 node-pty의 kill을 씁니다.
- 데몬 종료(유휴, `shutdown`, SIGTERM) 때도 같은 방법으로 모든 세션을 끝냅니다.
- 세션에 넘기는 환경에서는 `ELECTRON_RUN_AS_NODE`를 항상 뺍니다.

## 메모리 (2026-11-18, M 시리즈 macOS, Electron 44 as Node)

| 항목 | 값 |
| --- | --- |
| 유휴 데몬 RSS | 약 72MB |
| 200열 × 1,000줄이 찬 세션 20개 | RSS 167MB(+95MB), 추정치 69MB(세션당 3.4MB) |
| Node에서 같은 조건의 실제 버퍼 | ArrayBuffer 49MB + 힙 23MB |
| 화면만 스냅샷 | 9.4KB, 2ms |
| 히스토리 1,000줄 포함 스냅샷 | 201KB |
| 30MB 출력 처리 | 약 14.5~16MB/s(분리·붙음 비슷, 부하 평균 14일 때는 10~13MB/s). xterm 파싱이 병목 |

- `list`는 세션별로 `scrollbackLines`, `approxBytes`, `bytesIn`/`bytesOut`/`bytesWritten`, `droppedBytes`를 주고, 합계와 데몬 RSS·힙도 줍니다.
- 세션이 끝나면 화면을 reset한 뒤 dispose하고 1초 뒤 GC합니다(`--expose-gc`). Node에서 ArrayBuffer가 49MB에서 0.1MB로 줄었습니다. RSS는 할당기가 쥐고 있어 바로 줄지 않지만 새 세션이 다시 씁니다.
- 기본 scrollback은 200줄입니다. 대화 내용은 에이전트 기록 파일에서 읽으므로, 터미널은 지금 화면과 짧은 꼬리만 들고 있습니다. 200열 기준 세션당 약 0.3~0.6MB입니다(1,000줄은 약 1.9MB). `create`의 `scrollback`(최대 2,000)이나 데몬 `--scrollback`으로 바꿉니다.

## 개발용 실행

- `npm run test:term-host`: 임시 데이터 디렉터리에서 소스 데몬을 Node(tsx)로 띄우고 `/bin/sh`·`yes`·`cat`만 씁니다. 생성, 분리, 재접속, 복원, 측정, kill, 종료를 확인합니다.
- `npm run build:desktop` 뒤 `TERM_HOST_ELECTRON=node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`: 번들을 Electron as Node로 돌립니다.
- `TERM_HOST_ENTRY=<…/app.asar/dist-desktop/term-host.cjs>`: asar 안의 번들을 씁니다. node-pty `lib`는 asar 안에, prebuild는 unpacked에 둔 배치로 동작을 확인했습니다.
- `TERM_HOST_SESSIONS`, `TERM_HOST_COLS`, `TERM_HOST_SCROLLBACK`: 메모리 측정 조건을 바꿉니다.
- 자동 테스트는 다음 두 가지입니다.
  - `tests/term-host.test.ts`, `tests/term-host-edges.test.ts`: 가짜 PTY.
  - `tests/term-host-daemon.test.ts`: 실제 데몬과 `/bin/sh`. node-pty를 못 불러오거나 Windows면 건너뜁니다.

## 앱에서 쓰기 (2단계, #401)

- **설정**: '내장 터미널(실험)'(`preferences.builtinTerminal`, 기본 꺼짐). 켜고 macOS·Linux이면 실행 시트에 '내장 터미널'이 나옵니다. 꺼도 이미 떠 있는 세션은 계속 알아봅니다(중복 확인·답장).
- **앱 쪽 서비스** (`desktop/term-builtin.ts` `TermBuiltin`, 데이터 폴더는 `AGENT_OFFICE_DATA_DIR` 또는 `app.getPath('userData')`):
  - 데몬은 **실행할 때만** 띄웁니다(`bundledDaemon()`). 조회·화면 읽기·키 입력은 떠 있는 데몬에 붙기만 합니다. 소켓 파일이 없으면 `stat` 한 번으로 바로 '없음'이라 답하고, 토큰·디렉터리도 만들지 않습니다.
  - 세션 목록은 1초 동안 같은 답을 나눠 쓰고, 실패(답 없음 등)도 1초 동안 기억합니다. 조회 요청에는 2초 시간 제한이 있어, 멈춘 데몬이 조회 경로를 붙잡지 않습니다.
  - 조회용 연결 하나를 같이 쓰고 30초 동안 쓰지 않으면 닫습니다. 데몬은 세션도 클라이언트도 없을 때만 끝나기 때문입니다. 앱을 끄면 연결만 닫히고 세션은 데몬에 남습니다.
- **실행** (`builtinDestination`): 에이전트 어댑터의 단어를 그대로 argv로 넘깁니다(셸 없음, 첫 메시지는 `--` 뒤). Claude 2.1.16 이상이면 tmux처럼 `--teammate-mode in-process`를 붙입니다(`AgentLauncher.at.builtin`).
  - 환경은 앱의 것에서 시작합니다(`shellEnv`: tmux·Claude 표식과 `ELECTRON_RUN_AS_NODE` 제거, TERM·UTF-8). 여기에 다음을 더합니다.
    - 바이너리 폴더를 PATH 앞에 둡니다.
    - Orca 터미널 변수를 뺍니다.
    - 에이전트 홈은 Orca 탭 규칙을 따릅니다(앱 값으로 두거나 빼고, 상대 경로는 거절).
    - `AGENT_OFFICE_TERM_SESSION=<id>`, `AGENT_OFFICE_TERM_HOST=<프로토콜>`을 넣습니다.
  - 세션은 200×50, 스크롤백 200줄로 시작합니다.
  - Terminal 창처럼 `reserves`라, 에이전트가 보일 때까지 '시작 중'으로 예약합니다.
  - 응답 전에 연결이 끊긴 create는 `uncertain`(시작됐을 수 있음)입니다. 시작 0.6초 뒤 이미 없는 세션은 `builtinExited`(로그인·폴더 신뢰 확인 등에서 멈춤)입니다.
- **실행 위치 인식** (`desktop/terminal-host.ts` `findHost`): tmux 밖이고 세 가지가 모두 맞으면 `{ kind: 'builtin', session, label }`입니다.
  - env 마커가 있습니다.
  - 데몬 목록에 그 id의 살아 있는 세션이 있습니다.
  - 그 세션 pid가 이 프로세스 pty의 leader이고, leader의 부모가 데몬입니다.
  - 검증 못 한 경우(데몬이 답하지 않음 등)에는 `placeOfProcess`가 env 마커로 '내장 터미널에서 실행 중'(`where: 'builtin'`)이라고만 말합니다.
  - Codex 화면 인식은 데몬이 준 제목(스레드 id)으로 같은 길을 탑니다.
- **답장** (`desktop/terminals.ts` `HOST_IO.builtin`):
  - 화면은 `screen`으로 읽고 흐린 글자까지 봅니다(`styled: true`, `builtinScreen`).
  - 키는 tmux `send-keys`가 쓰는 것과 같은 바이트, 붙여넣기는 bracketed paste, Enter는 `\r`입니다.
  - 보내기 흐름(상태·전면 프로세스·화면 확인, 초안 보호, Enter 직전 재확인)은 tmux·Orca와 같은 코드를 탑니다.
  - 데몬에 닿지 못한 쓰기는 '보내지 않음'으로 알립니다.
- **화면 보기** (2b, `desktop/term-windows.ts`·`term-views.ts`, `src/components/TermWindow.tsx`·`TermPanel.tsx`):
  - 세션마다 창 하나(`#term`, 미니 터미널 창과 같은 팝업 규칙)에 xterm을 둡니다. "터미널로 이동"(`office:jump` → `focusHost` → `show`)과 실행 직후(원격 실행 제외)에 그 창이 열립니다. 첫 실행이 폴더 신뢰 같은 확인에서 멈춰도 보이게 하려는 것입니다. 화면 내용 숨기기 중에는 열지 않고, 켜지면 닫습니다.
  - 창은 세션을 고르지 못합니다. main이 연 창의 대상(`TermTarget`)만 attach하고, 명령은 `attach`·`detach`·`resize`·`flow`·`kill`뿐입니다(`parseTermCommand`).
  - **창마다 데몬 연결 하나**를 씁니다. 같은 세션을 두 창이 봐도 서로 출력을 빼앗지 않고, 느린 창은 데몬의 흐름 제어(밀리면 멈춤 → 새 스냅샷)를 따로 받습니다. 창이 그리지 못한 출력이 쌓이면(`OutputFlow`) main이 그 연결 읽기만 멈춥니다(`pauseReading`). 프로그램은 멈추지 않습니다.
  - 한 창의 resize와 흔들기는 차례로 보내고, 흔들기의 마지막 단계는 보낼 때의 창 크기를 씁니다. 그래서 늦게 끝난 흔들기가 그사이 바뀐 창 크기를 옛 크기로 되돌리지 않습니다.
  - attach: `restoreSequence`를 세션 크기의 새 xterm에 그린 뒤 창 크기로 맞춥니다. 크기를 한 번 흔들어(`nudgeSizes`: 다른 크기면 그 크기로, 같으면 한 줄 줄였다가 되돌림) SIGWINCH로 TUI가 다시 그리게 합니다. attach 응답보다 먼저 온 출력은 복원 화면 뒤에 그립니다. 기록은 200줄만 요청합니다.
  - 창이 가려지면(최소화 등 `visibilitychange` hidden) detach하고, 다시 보이면 새로 attach합니다. 닫거나 새로고침해도 detach합니다. **보이지 않는 동안에는 아무것도 흐르지 않습니다.**
  - 종료 버튼은 main의 확인창을 거칩니다. 확인창에는 끝날 대화(그 폴더의 Claude·Codex 중 이 세션에서 찾은 것), 에이전트, 폴더, 실행 중인 명령을 보여 줍니다. 확인 뒤 세션이 아직 있을 때만 kill합니다(SIGHUP 그룹 → 3초 뒤 SIGKILL).
- **한계**
  - macOS의 `ps -E`는 Apple 플랫폼 바이너리(`/bin/cat` 등)의 환경을 보여 주지 않습니다. 에이전트 CLI(Claude·Codex·node)는 보입니다. tmux·Orca 인식도 같은 전제입니다.
  - Linux는 실행·답장 경로는 같지만, 프로세스 환경·tty 읽기(`ps -wwE`, `ttys…`)가 macOS 기준이라 인식이 되지 않을 수 있습니다(기존 Linux 한계와 같음). 그동안은 '시작 중' 예약만 중복 실행을 막습니다.
  - 원격 사무실의 소환(`server/federation/launcher.ts`)은 별도 프로세스라 데몬에 묻지 않습니다. 내장 터미널 세션은 env 마커로 '그곳에서 실행 중'으로만 봅니다.

## 한계와 다음 단계

- 업무 카드 안에 뷰를 넣는 것(창이 아닌 인라인 임베드)은 범위 밖입니다. 카드는 대화를 기록에서 보여 주고, 터미널 화면은 창에서 봅니다.
- Windows(2b 이후 별도 이슈): 패키지에 node-pty, named pipe 강화, 자식 프로세스 트리 kill.
- 3단계: 보지 않는 유휴 에이전트를 재우고 resume으로 깨우기. 미니 셸의 tmux를 이것으로 교체.
- serialize 밖의 상태(문자 집합, 저장된 커서, 탭 정지 등)는 복원하지 않습니다. 대신 붙을 때와 밀려서 새 스냅샷(resync)을 받았을 때 크기를 한 번 흔들어(SIGWINCH) TUI가 다시 그리게 합니다(resync 때는 창마다 1초에 한 번까지).
- 스크롤 영역은 xterm 내부 값(`_core.buffer.scrollTop/scrollBottom`)을 읽습니다. 값이 없으면 복원을 건너뜁니다.
- 옛 프로토콜 데몬의 세션은 새 앱에서 보이지 않습니다(버전별 소켓). 프로토콜을 바꿀 때 이전 방법을 정합니다.
- Windows named pipe는 이름이 예측 가능하므로, 누가 먼저 같은 이름을 차지하면 토큰이 새어 나갈 수 있습니다. 또 Windows 패키지에는 아직 node-pty가 없습니다.
- 그룹 밖으로 나간 자손(`setsid`로 새 세션을 만든 데몬형 자식)은 kill이 쓸지 못합니다.
