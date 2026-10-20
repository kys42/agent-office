# macOS DMG 배포

개발용 **preview**와 **Developer ID 서명·Apple 공증** 경로를 분리한다. 기본 명령은 preview이며, 정식 경로는 아래 환경변수를 명시한다. 서명/공증 실패 시 preview로 대체하지 않는다. 빌드는 사용자 세션이나 인증 파일을 포함하지 않는다. 자동 업데이트와 공개 게시는 별도 작업이다.

## 로컬 생성과 설치

앱 아이콘 원본은 `public/icon.png`(투명 배경의 1024px PNG)다. 선택한 맥북 앞 미니 로봇 시안으로 교체했으며, 브라우저 favicon과 실행 중 Mac Dock도 같은 파일을 사용한다. 메뉴바의 흑백 template 심벌은 메뉴바용으로 유지한다. PNG를 변경하면 macOS에서 `npm run icon:mac`으로 16–1024px ICNS를 재생성해 `public/icon.icns`와 함께 커밋한다. 패키징은 커밋된 ICNS를 사용하며 Linux CI에서 Mac 변환 도구를 실행하지 않는다.

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
- 버전 태그는 아래 **macOS Signed Release**에서 처리한다. preview는 수동 실행만 지원한다.
- 두 경로 모두 Linux 품질 검사에 성공한 뒤 macOS job을 실행한다. arm64는 `macos-15`, x64는 `macos-15-intel`을 사용한다.
- 각 job은 최종 DMG를 mount → 앱을 임시 설치 경로로 복사 → 서명 검증 → 설치본 Electron 실행을 마친 뒤 DMG·JSON·체크섬을 30일 보관 artifact로 올린다.

이 파이프라인은 저장소 쓰기 권한이나 배포 비밀값을 요구하지 않는다. GitHub Release 공개 게시나 OTA 포인터 변경은 수행하지 않는다. 초기 내부 전달은 workflow artifact 또는 검증된 로컬 DMG를 사용한다.

## 설치본 검증과 복구

`npm run test:package`는 DMG hash와 설치본 메타데이터를 비교하고 `codesign --verify --deep --strict`를 실행한다. 임시 Claude·Codex·OpenClaw 합성 기록과 별도 앱 프로필·DB로 실행해 세 공급자 수집, 설정 저장, 언어 전환, 데스크 펫·책상 줄·바닥 책상, renderer 격리를 확인한다. macOS Dock 아이콘이 시작·펫·책상 줄·바닥·팝업·전체 복귀에서 유지되고 팝업이 키보드 입력을 받는지도 검증한다. 개발 Electron이나 브라우저 결과만으로 DMG 검증을 대신하지 않는다.

사용자 설치 뒤 첫 실행에서는 전체 사무실·트레이·펫 모드와 기존 세션 수집을 확인한다. 인터넷 다운로드의 Gatekeeper 검수와 Intel 검수는 해당 전달 경로 및 기기에서 별도로 확인한다. 테스트가 합성 DB에서 통과했다는 근거를 실제 개인 DB 업그레이드 검증으로 확대하지 않는다.

교체 전에 기존 앱과 종료된 앱의 데이터 폴더를 백업한다. 문제가 생기면 앱을 종료하고 이전 검증 앱으로 교체한다. DB 스키마가 달라지는 릴리스는 호환성을 먼저 확인하고 필요할 때 백업을 복원한다. 앱을 다운그레이드하며 DB를 자동 삭제하지 않는다.

## 정식 서명과 공증

앱 식별자는 `dev.kys.agentoffice`를 계속 사용한다. 같은 Apple Developer Team으로 서명하며, 인증서를 갱신할 때 Team ID를 바꾸지 않는다. `Developer ID Application` 인증서와 개인키가 필요하다. App Store용 Apple Distribution 인증서는 사용하지 않는다.

```bash
export AGENT_OFFICE_SIGNING=developer-id
export AGENT_OFFICE_SIGN_IDENTITY='Developer ID Application: YOUR NAME (TEAMID1234)'
export AGENT_OFFICE_TEAM_ID=TEAMID1234
# 이미 키체인에 등록한 notarytool 프로필 이름. 비밀번호를 셸 기록에 쓰지 않는다.
export AGENT_OFFICE_NOTARY_PROFILE=agent-office
npm ci
npm run package:dmg
npm run test:package
```

`npm run package`까지만 실행하면 로컬 진단용 **서명 완료·미공증 앱**을 만들 수 있다. `package:dmg`의 정식 모드는 깨끗한 커밋, 공증 프로필, 앱 서명 검증을 요구한다. 인증/네트워크 오류나 Apple 심사 거절을 성공으로 취급하지 않는다. 공증 대기에는 제출당 20분 제한이 있다. 시간 초과 뒤에는 아래 receipt 재개 절차를 사용한다.

순서는 **패키징 → 실행 파일 UUID 부여 → hardened runtime 서명 → 앱 ZIP 공증 → 앱 ticket staple/검증 → Gatekeeper 검사 → DMG 생성/서명 → DMG 공증/staple → 최종 체크섬 → DMG 설치본 실행 검수**다. 공증은 Apple에 앱/DMG 바이너리를 제출하는 작업이다. `scripts/entitlements.mac.plist`는 Electron JIT 권한만 선언한다. App Sandbox나 카메라·마이크·전체 디스크 권한을 일괄 부여하지 않는다.

앱의 봉인된 `release.json`은 서명 시점 기록이므로 `notarized: false`를 유지한다. 공증 뒤 이 파일을 고치면 서명이 깨진다. **현재 공증 여부는 stapled ticket과 DMG 옆 최종 manifest의 `notarized`, `notarization` 제출 ID**로 확인한다. `test:package`가 설치본과 DMG ticket을 검사한다. 단순히 JSON에 성공을 적는 것으로 검증을 대신하지 않는다.

### 기존 앱의 Apple 프로필 재사용

TaskDeck `native/macos-signing.json`과 반려주식 릴리스처럼 **Apple Team 신원은 재사용하고 앱 식별자·업데이트 키는 앱별로 유지**한다. 이 저장소는 비밀이 아닌 기존 프로필의 다섯 필드 `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`, `APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID`를 읽을 수 있다. `${HOME}` 접두 경로만 확장하고, API 키는 저장소 밖의 0600 일반 파일인지 확인한다. 사용자별 프로필과 키는 이 저장소에 복제하지 않는다.

```bash
export AGENT_OFFICE_APPLE_PROFILE=/absolute/path/to/existing/macos-signing.json
npm run release:mac -- preflight   # 서명 신원 + 읽기 전용 Apple 인증 확인
npm run release:mac -- app         # 서명 앱만: 공증 성공으로 해석하지 않는다
npm run release:mac -- dmg         # preflight → build → 앱/DMG 공증
npm run release:mac -- resume      # 기존 산출물/제출 ID로 재개, 앱 재빌드 없음
```

공증 API가 `403: A required agreement is missing or has expired`를 반환하면 인증서를 재발급하거나 키를 임의로 바꾸지 않는다. 계정 소유자가 Apple Developer 계정의 계약·멤버십 안내를 확인하고 필요한 법적 동의를 직접 완료한 뒤 `preflight`를 재시도한다. 이 오류만으로 어떤 계약이 문제인지는 확정할 수 없다. 기존 유효 인증서로 서명하는 것과 Apple 공증 서비스 접근은 별개다.

### 중단 후 재개

TaskDeck의 receipt 방식을 적용해 제출 ID를 기다리기 **전에** `.local/notary/`에 저장한다. 로컬 receipt에는 바이너리 지문·빌드 context·제출 시각·ID·상태가 있고 키 원문은 없다. `.local`은 Git에 포함하지 않는다. 대기 시간 초과 뒤에는 `release:mac -- resume`이 같은 ID를 기다린다. 앱은 코드 서명 자원/실행 파일의 지문, DMG는 제출 전·staple 후 SHA-256으로 동일성을 확인한다. 미완료 receipt가 있으면 새 패키징으로 기존 산출물을 덮어쓰지 않는다.

`id:null`이면 업로드 결과가 불명확하다. receipt를 지우고 자동 재제출하지 말고 같은 프로필로 Apple `notarytool history`와 후보 `info`를 확인한다. 파일명·제출 시각이 유일하게 일치하는 ID만 receipt에 복원한 뒤 재개한다. `Invalid`는 `notarytool log <ID>`를 조사하고 원인 수정 후 새 빌드로 전환한다. 실패 산출물/receipt를 별도 보관한 후에만 작업 receipt를 정리한다.

CI timeout은 hosted runner가 사라지므로 로컬 재개와 다르다. 실패 시 receipt와 기존 앱/DMG를 제한된 artifact로 보존해야 같은 산출물을 받아 재개할 수 있다. 일반 배포 artifact는 검증 성공 뒤에만 게시하며 복구 artifact를 최종 배포로 전달하지 않는다.

### 다른 서버와 GitHub Actions

[macOS Signed Release](../../.github/workflows/macos-signed.yml)는 main에 포함된 커밋의 수동 실행 또는 버전 태그로 실행한다. Linux에서 품질 검사를 하고, macOS arm64/x64 runner에서 최종 서명·공증·실행을 검사한다. Linux/Windows 서버는 소스 검증과 빌드 요청을 맡을 수 있지만 이 경로의 최종 Mac 패키징은 macOS/Xcode Command Line Tools가 필요하다. 일반 PR에는 서명 비밀값을 제공하지 않는다.

GitHub의 **`macos-release` environment를 먼저 생성**하고 허용 브랜치를 main, 허용 태그를 릴리스용 `v*`로 제한한다. 저장소 정책에 맞는 reviewer 보호도 적용한다. 코드 안의 ancestry 검사만으로 악의적인 workflow 변경을 막을 수 없으므로 environment 제한을 생략하지 않는다. 병합 전에 임의 feature ref로 secret job을 실행하지 않는다.

| 구분 | 이름 | 내용 |
| --- | --- | --- |
| Environment variable | `MACOS_SIGN_IDENTITY` | Developer ID Application 인증서 전체 표시 이름 |
| Environment variable | `APPLE_TEAM_ID` | 10자리 Team ID |
| Environment secret | `MACOS_CERTIFICATE_P12_BASE64` | 암호화한 인증서+개인키 P12의 base64 |
| Environment secret | `MACOS_CERTIFICATE_PASSWORD` | P12 내보내기 암호 |
| Environment secret | `APPLE_API_KEY_P8` | 공증용 App Store Connect 팀 API 개인키 |
| Environment secret | `APPLE_API_KEY_ID` | 해당 API key ID |
| Environment secret | `APPLE_API_ISSUER_ID` | 해당 팀 issuer ID |

로컬 키체인의 개인키를 자동으로 추출하거나 GitHub에 업로드하지 않는다. 소유자가 허용한 서명 키만 등록한다. P12/키 원문·Apple 계정 비밀번호·프로필 인증값은 Git, Notion, 로그, 산출물에 넣지 않는다. CI는 임시 키체인에 가져오고 `notarytool store-credentials`로 API 키 유효성을 확인하며, 원본 P12/P8과 마지막 키체인을 정리한다. 이 스크립트는 일회용 hosted runner용이다. 기존 키체인을 공유하는 장기 self-hosted 서버에는 그대로 적용하지 않는다.

다른 Mac에서 로컬 빌드를 하려면 같은 팀의 유효한 Developer ID 인증서+개인키와 공증 프로필을 별도 안전 경로로 설치하고 위 명령을 실행한다. 별도 키체인은 `AGENT_OFFICE_SIGN_KEYCHAIN`으로 지정한다. 인증서가 있다는 사실만으로 해당 기기에 개인키가 있거나 CI가 준비됐다고 판단하지 않는다.

공증 프로필은 `xcrun notarytool store-credentials agent-office`의 대화형 입력 또는 승인된 API 키 파일로 등록한다. Apple ID 방식은 앱 전용 암호를 사용한다. CI는 위 팀 API 키 방식으로 통일한다. 개인 API 키(issuer 없는 방식)는 현재 CI 스크립트 범위 밖이다.

### 유지보수와 복구

- 인증서/Apple Developer 멤버십 만료 전에 갱신하고 새 P12로 실제 서명·공증·설치를 검증한다. 기존 인증서가 단순 갱신 대상이라면 즉시 revoke하지 않는다. 이미 배포한 앱의 타임스탬프와 권한 연속성도 확인한다.
- API 키 만료·폐기·역할 변경 시 공증 프로필과 CI secrets를 갱신한다. 서명은 성공했으나 공증이 안 된 앱을 정식 배포 완료로 표시하지 않는다.
- 최종 DMG와 manifest, checksums, source SHA, 공증 제출 ID를 함께 보존한다. artifact 보관은 30일이며 장기 배포 저장소는 별도 결정한다.
- macOS 권한은 OS·사용자별로 관리된다. 서명은 신원 안정화이며 권한 자동 승인이나 기기 간 권한 복사를 뜻하지 않는다. 임시 서명에서 최초 전환할 때 사용자의 재승인이 필요할 수 있다.
- 자동 서명과 앱 자동 업데이트(OTA)는 별개다. 이 workflow는 artifact까지만 만들며 GitHub Release 공개 게시나 설치된 앱의 자동 교체를 수행하지 않는다. Windows Authenticode도 별도 인증서·파이프라인이 필요하다.

## 로컬 네트워크 권한과 Electron UUID

`NSLocalNetworkUsageDescription`을 앱에 포함한다. 수동 등록한 다른 Office endpoint를 연결하는 현재 구현에는 Bonjour 탐색 선언을 추가하지 않는다. launchd agent로 실행한다면 `AssociatedBundleIdentifiers`에 실제 앱 식별자를 지정한다. 시스템 권한을 우회하는 전역 네트워크 예외나 TCC DB 직접 수정을 사용하지 않는다.

Electron의 같은 실행 파일을 여러 앱이 공유하면 bundle ID가 달라도 LC_UUID가 같다. Apple TN3178/3179는 이 상황에서 네트워크 신원 판단이 혼동될 수 있다고 설명한다. `scripts/macos-signing.mjs`는 **최초 패키징 직후, 서명 전** 각 앱/Helper 실행 파일의 기존 UUID와 해당 bundle ID를 해시해 앱별 UUID를 부여한다. 공유 framework의 UUID는 바꾸지 않는다. 단일 arm64/x64의 64비트 little-endian Mach-O만 지원하며 잘못된 형식은 실패한다. 같은 원본/식별자의 결과는 결정적이다. 이미 패치한 파일에 재적용하지 않고 매번 원본 Electron에서 패키징한다.

이는 Electron 소스를 새로 컴파일하는 대신 이 저장소에서 수행하는 바이너리 후처리다. Apple이 제공한 UUID 수정 도구가 아니며 서명 후 수행하면 서명이 무효화된다. 원본→결과 UUID 매핑을 앱 메타데이터에 보관한다. 향후 해당 실행 파일 dSYM을 사용하면 UUID를 맞춘 별도 심볼 처리도 필요하다. Electron 버전/패키저 변경 시 `dwarfdump --uuid`와 실제 권한 창을 회귀 검수한다.

검수는 기존 앱 종료/데이터 백업 → Applications의 동일 경로로 새 앱 교체 → 기존 프로필 실행 → 사용자 Local Network 허용 → 실제 원격 snapshot/detail 확인 순서로 한다. CLI에서 HTTPS가 성공한 사실만으로 GUI 앱 권한 성공을 주장하지 않는다. Apple의 안내와 맞는 원인 후보를 고친 것이며 기존 장애 원인 확정이나 권한 해결 완료는 실제 실행 근거가 필요하다.

참고: [Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy), [Apple TN3178](https://developer.apple.com/documentation/technotes/tn3178-checking-for-and-resolving-build-uuid-problems), [Electron notarize](https://github.com/electron/notarize), [GitHub macOS 인증서 설치](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications).

## 적용한 서비스 운영 기준

my-service-management의 native CI 비용 분리와 application golden 중 시작·복구(APP-01), 입력·영속 저장(APP-02), 수동 OS 설치 및 복구(APP-03), 최종 OS 산출물 검수(APP-07)를 적용했다. 구현 범위는 preview 및 정식 서명/공증 경로·검증·artifact 전달이다. 자격증명 등록과 실제 공증 완료 여부는 실행별 근거로 판단한다. 공개 배포와 자동 업데이트는 후속이다. 구체적인 실행 결과는 [QA 기록](QA.md)에 날짜와 환경을 적고, 작업 상태는 Notion 프로젝트 작업 보드에서 관리한다.

runner 기준: [GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). 서명·공증 기준: [Electron distribution](https://www.electronjs.org/docs/latest/tutorial/distribution-overview).
