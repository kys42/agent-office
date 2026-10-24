# 원본 세션 제목 변경

## 제품 계약

업무 카드의 `⋯ → 세션 제목 변경`은 원래 Codex·Claude Code에 저장되는 제목을 바꾼다. 입력창은 카드 안에 열리고 대화는 유지한다. 열기/가용성 확인은 읽기만 한다. 대상 서버 이름과 원본 변경 안내를 확인한 뒤 `제목 저장`을 눌러야 쓴다. 제목은 공백 제거 후 1–120자이며 줄바꿈·제어문자를 받지 않는다.

기존 `이름 바꾸기`는 **사무실 별명**으로 명확히 이름을 바꿨다. 별명과 원본 제목은 별도다. 별명이 있으면 계속 별명을 보여 주며 새 제목으로 바꾸려면 별명을 비운다. 원본 저장 성공과 Office 수집 반영은 구분한다. 성공 후 다음 수집 때 제목이 반영되고, 원격에서는 해당 서버의 수집 및 수신 주기를 거친다.

| 대상 | 지원과 경계 |
| --- | --- |
| 로컬 Codex | 설치된 Codex의 공식 app-server `thread/name/set`. 정확한 원본 UUID·세션 헤더·CODEX_HOME 확인 후 실행 |
| 로컬 Claude Code | 공식 `@anthropic-ai/claude-agent-sdk` 0.3.310의 `renameSession`. 검증된 원본 파일에만 연결한 SessionStore 사용 |
| 다른 서버 | 해당 서버의 최신 office-peer와 `allowRename` 권한이 있는 직접 연결. 원본이 있는 서버에서 같은 어댑터 실행 |
| OpenClaw·하위/내부/예약 세션·복수 원본 파일 병합 | 미지원 사유를 표시. 페르소나 이름과 실행 제목을 혼용하지 않음 |
| 웹 미리보기·모바일·MCP | 이번 원본 변경 API를 노출하지 않음. 데스크톱 전용 trusted IPC |

Codex 데스크톱에서 서버에 연결만 해 둔 경우와, 원격 Office 송신기가 실제 원본을 읽을 수 있는 경우는 다르다. 이번 기능은 후자에 해당한다. 원격 Codex GUI 캐시를 직접 수정하거나 로컬 원격 전송 경로로 우회하지 않는다. 원래 앱의 목록이 이미 열려 있으면 그 앱의 재조회/재열기가 필요할 수 있다. 모든 공급자 버전의 화면 즉시 갱신을 보장하지 않는다.

## 구현과 출처

- `src/shared/session-title.ts`: 플랫폼 공통 입력·가용성·결과 규격.
- `server/session-title.ts`: 자체 구현한 검증·요청 장부·수송 계층. 공급자 제목 포맷을 임의 생성하지 않는다. Claude SDK가 생성한 custom-title 한 건을 정확한 파일에 append하고 fsync한다. SDK의 프로젝트 전체 UUID 검색을 사용하지 않아 같은 UUID 복사본·다른 설정 루트로 쓰기가 새지 않는다.
- Codex는 짧게 실행한 app-server에 initialize → initialized → thread/name/set만 보낸다. turn/start·resume·승인 응답을 보내지 않는다. 응답 크기/시간을 제한하고 종료한다. 모델 토큰 사용이나 새 작업 시작은 없다.
- Claude 파일은 생성하지 않고 기존 파일 핸들을 연다. UUID·헤더·논리적 공급자 루트가 일치해야 한다. 외장 디스크로 연결된 디렉터리는 지원하며 열린 inode를 유지한다. 끝이 불완전한 JSONL은 거절한다. 이 경로는 명시적 변경 기능이며 기존 수집기는 계속 읽기 전용이다.
- 상태 조회와 저장 직전 원본 제목을 다시 읽는다. 확인한 제목이 바뀌면 덮어쓰기를 거절한다. 다른 프로세스의 쓰기와 원자적 compare-and-swap까지 제공하는 공급자 API는 아니므로 최종 확인 직후 외부 변경과의 경합은 남는다.
- `session-titles/outgoing.sqlite`는 원본/Office DB와 별개다. 요청 ID와 payload 해시·상태만 보관한다. 동일 요청의 재전송은 이미 처리된 결과를 돌려주며 다른 payload는 거절한다. 미확인 시 자동 재시도하지 않는다. UI는 입력을 보존하고 원본 확인 후 다시 열도록 안내한다.
- 확인 버튼을 눌렀을 때만 읽고 쓴다. 새 상시 폴링·백그라운드 SDK 세션은 만들지 않는다.

공식 SDK 타입 정의와 npm 패키지가 재사용 정본이다. 라이선스와 고정 버전은 [외부 고지](../../THIRD_PARTY_NOTICES.md)·package-lock.json에 기록한다. Codex 메서드/파라미터는 설치 CLI의 `app-server generate-json-schema`로 확인했다. Office의 로컬 DB를 원본처럼 업데이트하지 않는다.

Electron/송신기 CommonJS 번들에서는 `scripts/node-bundle.mjs`가 SDK 내부의 `import.meta.url`을 현재 번들 파일 URL로 변환한다. SDK 원본 파일이나 설치본을 수정하지 않는 빌드 변환이다. 변환이 없으면 SDK의 createRequire 초기화가 실패하므로 `npm run test:title-bundle`로 실제 번들된 SDK가 합성 원본에 쓸 수 있는지 CI에서 검증한다. 이 번들은 제목 API만 사용하며 SDK의 모델 실행 API는 지원하지 않는다.

## 원격 설정

신규 송신기 초기화에서는 기존 공유 인수에 `--allow-send --profile-dir /absolute/profile --allow-rename`을 추가한다. `--allow-rename`만으로는 설정 검증을 통과하지 못한다. 제목 변경은 채팅 권한과 별도의 opt-in이며 기본 false다.

기존 연결은 송신기를 이 기능 포함 버전으로 업데이트하고 그 서버의 `export.json`에 `"allowRename": true`를 추가한다. 기존 sendToken을 쓰므로 토큰이나 연결 파일을 새로 만들 필요가 없다. 읽기 토큰만 있는 연결은 변경할 수 없다. 양쪽 기존 전송 설정, 공유 프로젝트 범위, 연결 상태, 수집 일시정지, 서버 epoch를 다시 확인한다. 구버전 송신기는 지원 불가 안내를 표시하며 쓰기를 시도하지 않는다. 설정 스키마가 strict이므로 구버전으로 롤백할 때 새 필드도 제거한다.

POST `/office/v1/commands/title-status`는 해시 세션 ID만 받고, `/title`은 ID·epoch·제목·기대 제목·요청 ID를 받는다. 경로·CLI·임의 RPC는 입력받지 않는다. 기존 TLS pin과 별도 command token 경계를 사용한다. 송신기 종료 시 진행 중 작업을 기다린다. 원격 Office SQLite는 계속 readOnly다.

## 검증

- `tests/session-title.test.ts`: 실제 Claude SDK로 원본 제목 반영, 대화·활동 시각 유지, 연결된 디렉터리, 잘못된 정체성/원본/부분 쓰기 거절, 요청 ID 재사용, Codex 프로토콜 허용 메서드.
- `tests/federation-commands.test.ts`: 실제 합성 HTTPS 연결에서 명시 권한, 읽기 토큰 거절, 공유 범위, 권한 회수, 서버 재시작/epoch, 중복 요청, 원본 Office DB 불변.
- `tests/ui/card.spec.ts`: 카드 내 입력, 서버 표시, 명시 저장, 별명 메뉴 구분, 권한 거절 및 미확인 결과의 재실행 차단.
- 2026-10-25 설치된 Codex CLI를 임시 CODEX_HOME으로 실행해 합성 스레드를 만들고, 새 app-server 프로세스에서 제목을 변경한 뒤 메타데이터 재조회로 저장을 확인했다. 실제 사용자 세션 제목은 변경하지 않았다. 별도 물리 서버·배포된 서명 앱에서의 종단 검증은 배포 후 수행한다.
