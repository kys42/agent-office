# macOS DMG 배포

현재 채널은 **preview**다. 최신 코드로 설치 가능한 DMG를 만들고 실제 설치본을 검증한다. 앱은 ad-hoc 서명이며 Apple Developer ID 서명·공증·자동 업데이트는 아직 지원하지 않는다. 빌드는 사용자 세션이나 인증 파일을 포함하지 않는다.

## 로컬 생성과 설치

Node 24+와 macOS가 필요하다. 릴리스용 checkout에서 아래 명령을 실행한다. 전달할 최종 산출물은 커밋을 확정한 깨끗한 checkout에서 다시 생성한다.

```bash
npm ci
npm run package:dmg
npm run test:package
```

기본 아키텍처는 현재 Mac이다. `AGENT_OFFICE_ARCH=arm64` 또는 `x64`로 지정할 수 있다. 설치본 실행 검증은 해당 아키텍처의 Mac에서 수행한다. Intel은 별도 CI runner에서 패키징·실행한다.

`release/Agent-Office-<version>-macOS-<arch>-<sha7>.dmg`를 열고 `Agent Office.app`을 Applications로 옮긴다. 기존 앱은 트레이 메뉴에서 종료하고 교체한다. 다운로드한 preview가 macOS에 막히면 출처를 확인한 뒤 시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기를 사용한다. 설치 안내는 DMG의 `INSTALL.txt`에도 들어 있다.

앱과 함께 Applications 바로가기, 프로젝트 라이선스와 서드파티 고지가 포함된다. 앱 내부 `Contents/Resources/release.json`과 DMG 옆 JSON에 버전, 전체 source SHA, 작업 트리 변경 여부, 아키텍처, Electron 버전, 생성 시각, 채널, 서명·공증 상태를 기록한다. JSON에는 DMG 파일 크기와 SHA-256도 들어 있다.

```bash
cd release
shasum -a 256 -c SHA256SUMS-arm64.txt
```

체크섬은 파일 손상 확인용이며 배포자 인증을 대신하지 않는다. 앱 식별자는 `dev.kys.agentoffice`, 저장소는 `~/Library/Application Support/Agent Office/office.sqlite`를 유지한다. 빌드마다 기본 설정이나 DB를 초기화하지 않는다.

## GitHub Actions

워크플로: [macOS DMG Preview](../../.github/workflows/macos-dmg.yml).

- 일반 push/PR: 기존 Linux `Verify`가 format·unit·build·MCP·UI를 검사한다. macOS 패키징은 실행하지 않는다.
- 수동 실행: Actions에서 `macOS DMG Preview` → Run workflow → 검증할 ref와 `arm64`, `x64`, `both`를 선택한다.
- 버전 태그: `v0.1.0`처럼 `package.json` 버전과 일치하는 태그를 push하면 두 아키텍처를 만든다. 태그 커밋이 main에 포함되어 있어야 한다.
- 두 경로 모두 Linux 품질 검사에 성공한 뒤 macOS job을 실행한다. arm64는 `macos-15`, x64는 `macos-15-intel`을 사용한다.
- 각 job은 최종 DMG를 mount → 앱을 임시 설치 경로로 복사 → 서명 검증 → 설치본 Electron 실행을 마친 뒤 DMG·JSON·체크섬을 30일 보관 artifact로 올린다.

이 파이프라인은 저장소 쓰기 권한이나 배포 비밀값을 요구하지 않는다. GitHub Release 공개 게시나 OTA 포인터 변경은 수행하지 않는다. 초기 내부 전달은 workflow artifact 또는 검증된 로컬 DMG를 사용한다.

## 설치본 검증과 복구

`npm run test:package`는 DMG hash와 설치본 메타데이터를 비교하고 `codesign --verify --deep --strict`를 실행한다. 임시 Claude·Codex·OpenClaw 합성 기록과 별도 앱 프로필·DB로 실행해 세 공급자 수집, 설정 저장, 언어 전환, 데스크 펫·책상 줄·바닥 책상, renderer 격리를 확인한다. 개발 Electron이나 브라우저 결과만으로 DMG 검증을 대신하지 않는다.

사용자 설치 뒤 첫 실행에서는 전체 사무실·트레이·펫 모드와 기존 세션 수집을 확인한다. 인터넷 다운로드의 Gatekeeper 검수와 Intel 검수는 해당 전달 경로 및 기기에서 별도로 확인한다. 테스트가 합성 DB에서 통과했다는 근거를 실제 개인 DB 업그레이드 검증으로 확대하지 않는다.

교체 전에 기존 앱과 종료된 앱의 데이터 폴더를 백업한다. 문제가 생기면 앱을 종료하고 이전 검증 앱으로 교체한다. DB 스키마가 달라지는 릴리스는 호환성을 먼저 확인하고 필요할 때 백업을 복원한다. 앱을 다운그레이드하며 DB를 자동 삭제하지 않는다.

## 공개 배포 후속

Developer ID Application 인증서와 공증 자격증명, hardened runtime·Electron entitlement 검증, Apple 공증 제출·stapling, quarantine가 붙은 다운로드 설치 검수, 보관할 공개 릴리스 채널을 확정한다. 비밀값은 저장소에 넣지 않는다. 인증서 준비만으로 공개 배포 완료라고 기록하지 않는다. 자동 업데이트는 설치본 보존·실패 복구·검증 후 게시 순서를 갖춘 별도 변경으로 도입한다.

## 적용한 서비스 운영 기준

my-service-management의 native CI 비용 분리와 application golden 중 시작·복구(APP-01), 입력·영속 저장(APP-02), 수동 OS 설치 및 복구(APP-03), 최종 OS 산출물 검수(APP-07)를 적용했다. 현재 구현 범위는 preview 생성·검증·artifact 전달이며 공개 배포와 자동 업데이트는 후속이다. 구체적인 실행 결과는 [QA 기록](QA.md)에 날짜와 환경을 적고, 작업 상태는 Notion 프로젝트 작업 보드에서 관리한다.

runner 기준: [GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). 서명·공증 기준: [Electron distribution](https://www.electronjs.org/docs/latest/tutorial/distribution-overview).
