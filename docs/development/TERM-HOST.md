# 내장 터미널 호스트 (1단계, #385)

tmux나 Orca 없이 앱이 에이전트 터미널을 띄우고 백그라운드에서 유지하기 위한 작은 데몬입니다. 1단계는 데몬, 프로토콜, 앱 쪽 클라이언트까지이며 UI와 실행 destination은 아직 없습니다(2단계).

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
- 요청은 `hello`(프로토콜 버전 + 토큰), `create`, `list`, `attach`, `detach`, `resize`, `kill`, `shutdown`입니다. 입력(write)은 응답 없는 데이터 프레임이고 같은 연결의 다른 메시지와 순서가 유지됩니다.
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
- JSON으로 8MB를 넘는 스냅샷(색이 아주 많은 긴 히스토리)은 히스토리를 절반씩 줄여 최신 부분만 보냅니다. 프레임 상한(16MB) 때문에 연결 전체가 끊기지 않게 하려는 것입니다.
- 클라이언트는 attach 응답 바로 뒤에 온 출력·종료·resync를 매크로태스크 하나만큼 붙잡아 둡니다. `await attach()` 한 쪽이 스냅샷을 먼저 그리게 하려는 것입니다.

## 흐름 제어

- PTY 읽기는 멈추지 않습니다. 커널 버퍼가 차면 에이전트가 멈추기 때문입니다.
- 붙은 화면이 없으면 헤드리스 화면에만 넣고 아무것도 보내지 않습니다.
- 그 출력 속의 질의(커서 위치 `ESC[6n`, 장치 속성 등)에는 헤드리스 화면이 답해 PTY로 돌려줍니다. 답이 없으면 기다리다 멈추는 프로그램이 있기 때문입니다. 출력을 받는 화면이 하나라도 있으면 그 화면(2단계의 xterm)이 답하고 헤드리스는 답하지 않으므로, 답이 두 번 가지 않습니다. 기준은 청크가 도착한 순간 누가 받았는지입니다.
- 클라이언트의 입력은 1MB 단위 프레임으로 나눠 보냅니다. 큰 붙여넣기도 프레임 상한에 걸리지 않습니다.
- 붙어 있으면 4ms 단위로 묶어 세션당 프레임 하나로 보냅니다.
- 소켓에 512KB 넘게 쌓이면 쓰기를 멈추고 `drain`을 기다립니다. 그동안 한 화면의 대기열이 4MB를 넘으면 버리고, 소켓이 비면 새 스냅샷(`snapshot` 이벤트)을 보냅니다.
- 스냅샷을 찍는 사이에 상한을 넘기면, 그 스냅샷 뒤에 한 번 더 새 스냅샷을 보냅니다.
- 이렇게 밀린 화면이 있는 채로 세션이 끝나면, 종료 이벤트 전에 마지막 화면을 보냅니다.
- xterm은 비동기 파싱이 50MB 밀리면 예외를 냅니다. 그 전에(32MB) 화면 반영만 건너뛰고 `droppedBytes`로 셉니다. 측정에서는 0이었습니다.

## 수명과 소켓 소유권

- 앱 데이터 디렉터리 아래 `term-host/`(0700)에 토큰(0600, 64자 hex)과 로그를 둡니다.
- 소켓은 `term-host/v<프로토콜>.sock`입니다. 경로가 100바이트를 넘으면 `/tmp/agent-office-term-host-<uid>/<해시>/`를 쓰고, 이 디렉터리는 소유자와 권한을 확인만 하고 고치지 않습니다.
- Windows는 사용자와 데이터 디렉터리로 키를 만든 named pipe를 씁니다.
- 프로토콜 버전이 소켓 이름에 들어가므로 새 앱은 새 데몬을 띄우고 옛 데몬은 자기 세션을 유지합니다.
- `connectTermHost`는 붙어 보고, 소켓이 없거나 거절되면 데몬을 한 번 띄운 뒤 붙을 때까지 재시도합니다. 데몬이 종료 중이면 hello를 거절하고 클라이언트는 다음 데몬으로 재시도합니다.
- 소켓 게시는 Orca의 데몬 규칙(AGENTS.md)을 따랐습니다.
  - 비공개 이름(`.p<hex>`)에 bind하고 `link`로 공개 이름을 차지합니다.
  - 이미 있으면 접속해 보아, 거절되거나 없을 때만 죽었다고 봅니다. 시간 초과나 권한 오류는 아무것도 증명하지 않으므로 물러납니다.
  - inode를 다시 확인하고 한 번 더 접속해 본 뒤 `rename` 한 번으로 바꿉니다.
  - 종료하는 데몬은 공개 이름을 지우지 않습니다.
  - 그래서 앱 두 개가 동시에 데몬을 띄워도 하나만 게시하고 나머지는 종료 코드 20으로 끝납니다.
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
| 30MB 출력 처리 | 약 14.5~16MB/s(분리·붙음 비슷). xterm 파싱이 병목 |

- `list`는 세션별로 `scrollbackLines`, `approxBytes`, `bytesIn`/`bytesOut`/`bytesWritten`, `droppedBytes`를 주고, 합계와 데몬 RSS·힙도 줍니다.
- 세션이 끝나면 화면을 reset한 뒤 dispose하고 1초 뒤 GC합니다(`--expose-gc`). Node에서 ArrayBuffer가 49MB에서 0.1MB로 줄었습니다. RSS는 할당기가 쥐고 있어 바로 줄지 않지만 새 세션이 다시 씁니다.
- 기본 scrollback은 1,000줄이고 `create`의 `scrollback`(최대 10,000)이나 데몬 `--scrollback`으로 바꿉니다.

## 개발용 실행

- `npm run test:term-host`: 임시 데이터 디렉터리에서 소스 데몬을 Node(tsx)로 띄우고 `/bin/sh`·`yes`·`cat`만 씁니다. 생성, 분리, 재접속, 복원, 측정, kill, 종료를 확인합니다.
- `npm run build:desktop` 뒤 `TERM_HOST_ELECTRON=node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`: 번들을 Electron as Node로 돌립니다.
- `TERM_HOST_ENTRY=<…/app.asar/dist-desktop/term-host.cjs>`: asar 안의 번들을 씁니다. node-pty `lib`는 asar 안에, prebuild는 unpacked에 둔 배치로 동작을 확인했습니다.
- `TERM_HOST_SESSIONS`, `TERM_HOST_COLS`, `TERM_HOST_SCROLLBACK`: 메모리 측정 조건을 바꿉니다.
- 자동 테스트는 다음 두 가지입니다.
  - `tests/term-host.test.ts`, `tests/term-host-edges.test.ts`: 가짜 PTY.
  - `tests/term-host-daemon.test.ts`: 실제 데몬과 `/bin/sh`. node-pty를 못 불러오거나 Windows면 건너뜁니다.

## 한계와 다음 단계

- 앱은 아직 이 데몬을 쓰지 않습니다. 2단계에서 실행 코어에 '내장 터미널' destination을 추가하고 카드·창에 xterm으로 붙입니다(`app.getPath('userData')`, `bundledDaemon()`).
- serialize 밖의 상태(문자 집합, 저장된 커서, 탭 정지 등)는 복원하지 않습니다. 2단계에서 붙을 때 크기를 한 번 흔들어(SIGWINCH) TUI가 다시 그리게 할 계획입니다.
- 스크롤 영역은 xterm 내부 값(`_core.buffer.scrollTop/scrollBottom`)을 읽습니다. 값이 없으면 복원을 건너뜁니다.
- 옛 프로토콜 데몬의 세션은 새 앱에서 보이지 않습니다(버전별 소켓). 프로토콜을 바꿀 때 이전 방법을 정합니다.
- Windows named pipe는 이름이 예측 가능하므로, 누가 먼저 같은 이름을 차지하면 토큰이 새어 나갈 수 있습니다. 또 Windows 패키지에는 아직 node-pty가 없습니다.
- 그룹 밖으로 나간 자손(`setsid`로 새 세션을 만든 데몬형 자식)은 kill이 쓸지 못합니다.
