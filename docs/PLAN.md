# Agent Office 구현 계획 · 2026-10-04

사용자가 선택한 시안 E를 바탕으로 독립 macOS 앱을 만든다. 초기 UI 전용 기획보다 이번 요청(실연동·프로덕션 구현)을 우선한다.

- 정본 카드: https://app.notion.com/p/3ee9c0323a9e8145929fd522397579e3
- 디자인 소스: kys42/claude-skills, 9a644d65e651e55213af2fe409d09e37f12a849e
- 선행 확인: 01-brief, 02-design-concepts, E-Office 원본, 스프라이트 manifest, 32쪽 기능 카탈로그, RTK, work-manager, frontend-design, pdf, ai-agent-manager.
- 핵심 규칙: 읽기 전용 수집; 세션과 장기 직원 구분; 추정과 관측 구분; 무응답을 종료로 단정하지 않음; 누적 토큰과 컨텍스트 구분; 원문은 명령으로 실행하지 않음.

## 구조와 검증

1. server/adapters: Claude JSONL, Codex JSONL+제목 DB, OpenClaw JSONL+현재 SQLite. 실제 포맷을 확인하고 누락/중복/부분기록 회귀 테스트.
2. server/store/service: SQLite 정규화 저장소, 별명·노트·핀·보관, 단일 조회 경계, 제한된 검색과 인수인계.
3. src: 시안 E의 맵·캐릭터, 동작·y 정렬, 반응형 오피스, 상세·기억·활동·연결 설정.
4. desktop: 격리된 렌더러 IPC, 워커 수집, 미니 오피스, 트레이, 창 복귀, macOS 패키지.
5. server/mcp: 동일 저장소에 읽기 전용 MCP. 자동 등록이나 외부 전송 없음.
6. 회귀 테스트+타입 검사+빌드+실제 세션 및 UI smoke+독립 코드 리뷰.

140개 후보 전체 구현을 주장하지 않는다. 첫 완결 범위는 실제 관찰 → 기록 이해 → 검색 → 인수인계 파일이다. 네이티브 서명·공증, 공식 이벤트/훅 기반 승인 전달, 모델 요약 실행·예약, 원격 동기화는 별도 단계다.
