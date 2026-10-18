# Windows 지원과 검증

관련: [전체 점검 #165](https://github.com/kys42/agent-office/issues/165), [기본 셸 #81](https://github.com/kys42/agent-office/issues/81), [네이티브 연결 #166](https://github.com/kys42/agent-office/issues/166), [배포 수명 #167](https://github.com/kys42/agent-office/issues/167).

## 이번 변경의 기준

사용자의 Windows 실제 화면에서 Electron 기본 제목/아이콘과 File·Edit·View·Window 메뉴가 앱 헤더와 중복됐다. macOS 전용 설정을 공통으로 적용한 것이 원인이다. main `e621e2d`와 별도 LAN 베타 PR162 `119cb61`을 점검했다. 구현 PR은 main을 기준으로 하며, PR162·PR164의 기능을 합치거나 기존 설치 앱을 자동 교체하지 않는다.

선행 문서: [제품 맥락](../golden/PROJECT-CONTEXT.md), [기능 정책](../golden/FEATURE-POLICY.md), [설계 시스템](DESIGN-SYSTEM.md), [아키텍처](ARCHITECTURE.md), [터미널 연결](TERMINAL.md), [팝업 카드](POPUP-CARDS.md). 플랫폼 표현만 나누고, 원본 세션 읽기 전용·IPC 격리·사용자 선택 전 무입력·가구/상태 의미는 유지한다.

## 기능별 지원 매트릭스

| 영역 | Windows 현재 근거 | 남은 검증/작업 |
| --- | --- | --- |
| 메인 창 | Windows 전용 36px 제목줄과 native caption overlay. 기본 메뉴 제거, Ctrl 편집·팔레트, 최소화 복귀, 닫기→트레이 | Snap hover/Win+Z, 고대비·스크린리더, 다양한 작업표시줄과 배율 수동 검수 |
| 모양/단축키 | OS 테마와 caption·시작 배경 연동, Segoe UI, 팔레트·기억·도움말·가이드·전송 설명의 Ctrl 표기 | IME 조합/키보드 레이아웃·고대비 수동 검수 |
| 로컬 조회 | Windows native Claude/Codex 기록에서 세션 수집 확인. SQLite·검색·메모/핀·북마크는 공통 구현 | 전체 사용자 이력/모든 공급자 버전의 호환 보장은 아님. OpenClaw 실제 Windows 설치는 미검증 |
| Git/파일 | Windows APPDATA 기본 경로, 명시한 data override 유지, Git CRLF 줄 분리 | UNC·네트워크 드라이브·WSL 경로 이관/중복은 #166 |
| 펫/줄/바닥/카드 | 기존 Windows native smoke의 합성 3종·팝업·IPC 저장·격리 검증을 재사용 | 다중 DPI/모니터 해제·음수 좌표·전체 화면·투명 클릭 통과의 수동 매트릭스는 #167 |
| 트레이/프로세스 | 앱 PNG 컬러 트레이, ICO EXE·창 아이콘, 최소화→열기/닫기→다시 열기 | toast·시작 프로그램은 기존 제품에 없는 기능. crash recovery/업데이트 수명은 #167 |
| 로컬 터미널 제어 | Orca/tmux/ps/lsof 기반. Windows 이동·전송·질문 응답 미지원 안내 | Windows 소유권/시작 시각/대상 identity 어댑터와 Codex Desktop named pipe 검증은 #166. 임의 창 제목으로 대상을 추정하지 않음 |
| 사용량·GitHub | Claude 파일 자격증명, Codex read-only RPC, gh 경로의 공통 로직 | Windows npm cmd shim·Store 설치/PATH·콘솔 창·deep link fallback·권한은 #166. macOS keychain 경로를 Windows에 적용하지 않음 |
| WSL | native Windows 로그 위치만 기본 수집 | 배포판 선택·Linux 경로·프로세스 분리·탐색 UX 미구현, #166 |
| LAN 베타 | PR162의 Windows client 합성 HTTPS/권한 테스트 통과. 이번 PR과 별도 | 이 PC에 connection.json이 없어 실제 Windows↔Mac 조회 미검증. exporter ACL/OpenSSL/방화벽은 #167 |
| 배포 | package:win의 portable·ICO·source manifest, Windows native PR CI | installer·서명·SmartScreen·자동 업데이트/삭제 데이터 보존은 #167 |
| 접근성/알림 | 기존 semantic 버튼·키보드·reduced motion 유지. native caption 사용 | Windows Narrator·고대비·OS 알림/집중 지원은 수동 확인 또는 후속 제품 결정 |

## 창 구조

Windows는 `titleBarStyle: hidden` + `titleBarOverlay`를 사용한다. 최소화·최대화·닫기는 HTML로 다시 만들지 않고 OS가 그린다. `windows-titlebar`만 drag 영역이며 `env(titlebar-area-x/width)`로 caption 영역을 비워둔다. 앱 본문·오른쪽 카드 전체는 그 아래에서 시작하므로 1050px 창에서도 caption과 충돌하지 않는다. macOS의 hiddenInset·vibrancy·traffic lights는 기존대로 유지하고 Linux는 기본 프레임을 쓴다.

관련 [Electron 제목줄 가이드](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar). `nativeTheme.updated`가 네이티브 배경과 버튼 색을 갱신하며 CSS는 prefers-color-scheme을 따른다. 컨텍스트 메뉴와 Ctrl 편집·팔레트는 보존한다. 명시적 종료는 기존 트레이 Quit를 쓴다.

## 데이터와 기존 설치 보존

Windows 기본 DB는 `%APPDATA%/Agent Office/office.sqlite`다. APPDATA가 없으면 사용자 홈의 `AppData/Roaming`을 쓴다. `AGENT_OFFICE_DATA_DIR`가 있으면 최우선이며 Electron·standalone collector·MCP가 같은 함수를 쓴다. 다른 플랫폼의 역사 경로는 유지한다. 예전 Windows의 `~/Library/Application Support/Agent Office`를 자동으로 복사하거나 삭제하지 않는다. 이 경로를 쓰던 사용자는 기존 위치를 override로 지정한 채 데이터 이관 여부를 별도로 결정한다.

설치된 베타는 별도 profile/data/federation 경로와 `--user-data-dir`를 사용한다. 일반 앱과 베타의 프로필을 합치지 않는다. 데이터 변경 없는 검수는 임시 profile·합성 공급자 경로로 실행한다.

## 빌드와 검수

Windows x64, Node 24 이상:

```powershell
npm ci
npm run package:win
$env:AGENT_OFFICE_EXECUTABLE = '생성된 release 경로/Agent Office.exe'
npm run test:windows
npm run test:desktop
```

`icon:win`은 기존 승인 PNG를 Electron nativeImage로 256px PNG-compressed ICO로 변환한다. 별도 디자인/그림 생성은 하지 않는다. `package:win`은 source SHA와 dirty 표시가 있는 별도 release 경로에 최소 앱 파일만 묶으며 기존 설치본을 덮어쓰지 않는다. `resources/release.json`의 platform·sourceCommit·sourceDirty·arch·signing을 확인한다. preview는 **unsigned**이며 installer/공식 업데이트 채널이 아니다.

`.github/workflows/windows-preview.yml`은 관련 PR과 수동 실행에서 Windows runner를 사용한다. portable EXE에 대해 격리된 native smoke를 실행하고 패키지와 합성 화면을 artifact로 보관한다. Linux Verify와 기존 Mac DMG workflow는 유지한다.

`test:windows`는 caption 영역, 메뉴 숨김, Ctrl+K/선택·복사, 테마 전환, 최대화·복귀, 최소 창 크기, 트레이 닫기·복귀를 확인한다. 기존 native smoke는 펫·책상·카드와 IPC 격리를 담당한다. native 호출 성공만으로 실제 Snap flyout·스크린리더·모든 DPI를 검증했다고 보고하지 않는다.

## 작업 범위와 마무리

전체 발견 사항은 #165, 네이티브 기능은 #166, 정식 배포 수명은 #167이 맡는다. 이번 PR은 #81의 기본 셸과 재현 가능한 Windows preview 기반을 해결한다. 로컬 기능 구현·합성 검증·CI·독립 리뷰와 main 병합·기존 설치 앱 교체는 별도 단계다.
