# 여러 Office 연결 베타

같은 데스크톱 앱에서 여러 컴퓨터의 관측 결과를 모아 본다. 기본값은 꺼짐이며, 설정의 **여러 사무실 연결 베타**에서 켠다. 중앙 동기화 서버나 계정은 없다. 원격 변경·전송 기능은 제공하지 않는다.

## 경계와 데이터 흐름

```mermaid
flowchart LR
  A[원격 기존 Office 수집기] --> B[(원격 기존 SQLite)]
  B -->|readOnly| C[office-peer HTTPS API]
  C -->|인증된 직접 조회| D[PeerManager 메모리]
  E[로컬 OfficeService] --> F[FederatedService]
  D --> F
  F --> G[기존 앱 사무실과 업무 카드]
```

- `server/federation/`이 별도 API·프로토콜·클라이언트·합성 계층이다. 기존 `/api/rpc`, MCP, `OfficeService` 저장 흐름은 그대로다. 네트워크 API는 GET `/office/v1/snapshot`, `/office/v1/detail` 두 개뿐이다.
- 송신기는 기존 SQLite를 readOnly로 열며 수집기, migration, seat 할당, 사용자 설정 쓰기를 실행하지 않는다. 기존 Office가 수집한 가시 세션과 명시한 프로젝트 범위의 교집합만 제공한다.
- 수신기는 원격 내용을 기존 SQLite에 쓰지 않는다. `federation-beta/peers.json`에 연결 설정만 저장한다. 원격 스냅샷·상세는 메모리에만 있고 앱 종료 시 사라진다. 베타를 끄면 요청/타이머/캐시를 폐기하고 기존 로컬 스냅샷으로 복귀한다. 송신 프로세스는 별도로 중지해야 한다.
- `officeId + 원격 ID의 SHA-256`으로 세션·부모·배우·이벤트·workspace ID를 격리한다. 다른 컴퓨터의 같은 원본 ID도 충돌하지 않는다. 원격 절대 경로·별명·메모·개인 핀·읽음 상태·공급자 인증 정보는 DTO에서 제외한다. **제목, 프로젝트, 활동 발췌, 대화 본문에는 사용자가 쓴 경로나 민감한 글이 포함될 수 있다. 본문 익명화 기능은 아니다.**
- 기본은 컴퓨터별 별도 방이다. 연결에 표시 이름·태그를 주고 검색할 수 있다. 프로젝트 대응표 `원격 프로젝트 = 로컬 표시 프로젝트`를 입력하면 해당 로컬 프로젝트와 같은 구역으로 보인다. 원본 프로젝트명/DB/기존 area 규칙은 바꾸지 않고 베타 화면에서만 적용한다.
- 원격은 읽기 전용이다. 상세 대화 외에 로컬 터미널 이동·send·resume·answer·notes·pin·가리기·북마크·인수인계를 지원하지 않는다. 렌더러에서 버튼을 숨기는 것과 별도로 IPC/service에서도 remote ID를 거절한다. 로컬 전문 검색·소식·MCP에는 원격 기록이 포함되지 않는다.

## 연결과 권한

TLS 자체 서명 인증서의 SHA-256 지문과 256-bit bearer token을 `connection.json`으로 전달한다. 이 파일은 비밀이며 SSH/SCP 등 이미 신뢰한 경로로 전달한다. 인증서 지문과 유효기간을 확인한 **후** HTTP 토큰을 보낸다. 자동 발견·TOFU·브라우저 CORS·리디렉션은 없다. 인증서 변경 시 파일을 새로 전달하고 연결을 다시 등록한다.

설정 디렉터리는 0700, token/키 파일은 0600이다. 송신기는 매 요청마다 설정과 공유 범위를 다시 읽는다. `export.json`의 `enabled: false`, token 교체, 프로젝트 축소가 다음 요청부터 적용된다. 클라이언트의 권한/인증서/프로토콜 오류는 해당 캐시를 제거한다. 일반 네트워크 장애는 마지막 정상 관측에 연결 끊김을 표시하고 최대 24시간 유지하며, 일하는 중/주의 필요 집계에서 제외한다.

조회는 연결당 5초 간격이고 실패 시 최대 60초까지 늘린다. 요청 제한 5초, 응답 16 MiB, Office당 900 세션, 최대 5개 연결이다. `epoch/version`이 같으면 변경 없음 응답, 변경되면 전체 bounded snapshot을 받는다. 원격 delta 전송은 아직 없다. 기존 데스크톱 snapshot/patch 구독은 그대로 쓴다.

수신 시각은 네트워크 조회 성공 시각이다. 원격 수집기가 살아 있다는 heartbeat가 아니며 기존 관측 시각·상태 파생 규칙을 함께 해석한다. `paused`는 stale로 표시한다. 상세는 최근 최대 180개, 이벤트당 64,000자이고 잘린 경우 partial이다. 이전 대화 페이지는 지원하지 않는다.

## 실행

Node 24 이상, OpenSSL과 빌드가 필요하다. 같은 저장소의 번들 `dist-desktop/office-peer.cjs`를 사용한다. 송신할 컴퓨터에서는 기존 Office를 계속 실행한다.

```sh
npm run build
# 실제 LAN 인터페이스 주소와 별도 설정 경로 지정
npm run peer -- --init --host 192.168.1.20 --port 4320 \
  --project agent-office --conversation --config-dir /private/path/office-peer
npm run peer -- --serve --config-dir /private/path/office-peer \
  --data-dir "/path/to/existing/Agent Office"
```

`--all-visible`은 모든 가시 프로젝트를 명시적으로 공유한다. `--conversation`은 최근 대화 상세 조회를 허용한다. 이 옵션이 없어도 스냅샷에는 제목·활동·최근 4개 발췌가 들어간다. 전체 대화 허용과 공유 프로젝트 범위를 먼저 선택한다. 초기화는 기존 export.json을 덮어쓰지 않는다.

수신할 컴퓨터에서 같은 앱의 설정 → 여러 사무실 연결 베타 켜기 → 전달받은 `connection.json` 가져오기를 누른다. 이름·태그·프로젝트 대응표는 로컬 연결 설정에 저장된다. 재등록하면 endpoint/token/인증서를 교체할 수 있다.

개발 중 기존 앱 데이터를 보존하려면 별도 worktree에서:

```sh
npm run build
npm run start:beta
```

동일 앱을 `.local/beta-preview/`의 별도 개발 프로필·DB·연결 설정으로 실행한다. 로컬 공급자 로그는 읽기만 하며, 원래 설치 앱·기존 DB·환경설정을 교체하지 않는다. 베타 기능 기본값은 이 프로필에서도 꺼짐이다. 기본 앱을 실행할 때는 평소와 같이 `npm start`이며, 기존 데이터를 읽고 쓰는 앱 동작 자체는 유지된다.

중지는 송신기 foreground의 Ctrl+C 또는 확인한 송신 프로세스의 SIGTERM이다. 수신 설정의 베타 끄기는 원격 캐시와 네트워크만 중지한다. 연결 제거는 저장한 token도 제거한다. 즉시 접근 권한을 회수하려면 송신 설정을 비활성화하거나 token을 회전한다. 인증서/호스트/포트 변경은 송신기 재시작이 필요하다. 로그·PR·스크린샷에 connection.json을 노출하지 않는다.

## 단계별 확장

1. LAN: 특정 주소/포트로 HTTPS 직접 연결. 이 구현과 실제 두 Mac 검증 범위다.
2. Tailscale: 접근 가능한 tailnet IP/DNS를 endpoint로 사용하고 해당 인터페이스에 bind한다. 동일 TLS pin/token 프로토콜을 재사용한다. 현재 Tailscale 실환경 검증은 하지 않았다.
3. 외부 계정: 미구현. 추후 연결 승인·만료·권한 주체를 credential provider로 분리하고 현재 officeId/DTO/읽기 모델을 재사용할 수 있다. 공인망 포트 공개나 다중 사용자 권한·감사 시스템은 이 베타의 범위가 아니다.

## 검증

`tests/federation.test.ts`: 기본 꺼짐/no-network, 응답 경쟁, ID/부모 격리, DTO 필드 허용 목록, 로컬 원본 불변, 원격 쓰기 거절, 실제 TLS pin-before-token, 권한·scope·readOnly DB 검증.

```sh
npm test
npm run build
npm run test:federation:desktop -- /private/path/connection.json
```

마지막 명령은 임시 로컬 fixture와 개발 프로필을 만들고 실제 peer 조회→화면→상세→쓰기 거절→베타 끄기를 검증한다. stdout은 집계만 출력하고 실제 원문은 보존하지 않는다. 공개 CI는 실제 개인 LAN에 의존하지 않는다. 결과와 제한은 [QA](QA.md)에 기록한다.
