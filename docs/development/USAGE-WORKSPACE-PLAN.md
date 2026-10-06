# 2026-10-05 · 사용량과 작업 위치 확장 계획

정본 카드: https://app.notion.com/p/3ee9c0323a9e8145929fd522397579e3
결과물: PR #1에 사용 한도 조회, 세션별 관측 비용 장부, 요청 도착/집중 연출, 실제 실행 위치 관측을 포함한다. 구현·로컬 전달·PR/CI까지이며 병합은 별도다.

선행 가이드: 골든 정책 v5, 관측 규격 v1, ARCHITECTURE, SESSION-INGESTION, OFFICE-ASSETS, Work Manager INDEX와 Notion 운영 가이드. canonical identity·원본 읽기 전용·미관측 null·표시 장식과 실행 상태 분리를 유지한다.

- `server/quotas.ts`, API/preload, UsagePanel: 버튼으로만 조회. Codex CLI 읽기 RPC / Claude 기존 OAuth 사용량. 인증값은 서버 메모리 안에만 두고 로그·DB·브라우저로 보내지 않는다. 60초 캐시·중복 요청 결합·타임아웃·프로세스 정리. 실패/미지원은 0%로 표시하지 않는다.
- `server/pricing.ts`, normalize/merge/store, Inspector: native 사용 표본별 중복 제거 장부. 현재 공개 표준 기본 단가의 USD 환산. 실제 청구·구독 비용·현재 한도와 별개. 모델 미확인·수집 누락은 표기한다.
- `working-location.ts`, workspaces/branch/Inspector: 명시적 shell workdir/cwd 또는 literal leading cd만 읽는다. 코드 평가·임의 파일 읽기·PR 링크 추측은 하지 않는다. 검증된 Git workspace만 표시 팀에 반영하고 원본 cwd/branch는 보존한다.
- presentation/Office/CSS: 새 요청의 서류·요청 발췌, 현재 요청 이후 5분/15분 집중 연출. 오래된 기록·휴식·응답 완료에는 꺼진다. 개인정보/모션 감소 준수.

검증: quota normalization/cache/process lifecycle, streaming·재수집·재시작 비용 중복, 명시 경로/동적 코드/읽기만 하는 경로 구분, 관측 상태와 연출, 합성 UI와 실제 로컬 연결. typecheck/build/기존 회귀·PR diff 리뷰·CI 확인 후 정본 정책/출처/QA/작업 기록/카드 갱신.
