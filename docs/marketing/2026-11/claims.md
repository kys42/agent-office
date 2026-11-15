# 홍보 표현의 근거

기준 소스 `38ac516` 및 이번 작업 브랜치. 홍보는 실제 기능 확인을 통과한 항목만 사용한다. 미병합 별도 기능 PR을 이미 출시된 기능으로 쓰지 않는다.

| 표현 | 근거 | 표현 제한 |
| --- | --- | --- |
| Claude Code·Codex·OpenClaw 실제 세션 | `server/adapters/`, SESSION-INGESTION | 모든 버전·모든 세션 자동 연결 보장은 하지 않음 |
| 같은 프로젝트/브랜치, 보조 관계 책상 | `src/shared/office*`, GOLDEN-OFFICE-POLICY | 원본에서 관계/브랜치를 관측하지 못하면 추정임을 감추지 않음 |
| 요청·진행·최종 응답 구분 | `src/shared/conversation.ts`, 업무 카드 UI | 에이전트 비공개 내부 추론을 읽는 기능 아님 |
| 데스크 펫/책상 줄/큰 사무실 | `DeskDock`, `Office`, FEATURE-POLICY | 합성 캡처에 실제 운영 세션을 섞지 않음 |
| 최근 기록·필요할 때 이전 기록 | store/detail paging, MEMORY/PERFORMANCE 관련 테스트 | 특정 MB 고정 또는 무한 기록 무비용 보장 금지 |
| 기본 로컬 수집·저장 | ARCHITECTURE | 외부 통신이 전혀 없다고 쓰지 않음 |
| 메시지 전송 | TERMINAL, MOBILE-WEB, 공급자별 capability | 모든 터미널 제어·자동 승인 표현 금지 |
| 모바일 웹 | MOBILE-WEB, opt-in HTTP/Host/Origin/auth 테스트 | 같은 Tailscale 및 앱 실행 필요. 공개 인터넷 링크 아님 |
| 서명 앱 | MACOS-RELEASE 및 실제 release receipt | 현재 변경이 공증된 설치본에 반영됐는지는 별도 검증 |

고객 수, 생산성 배수, 다운로드 수, 추천사, 무제한 무료, 완벽한 보안, 모든 플랫폼 지원 같은 근거 없는 문구는 넣지 않는다. 현재 저장소/릴리스 공개 여부와 PolyForm Noncommercial 라이선스의 사용 범위를 게시 전에 확인한다.
