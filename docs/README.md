# Agent Office 문서 지도

처음 이어받을 때는 **프로젝트 맥락 → 골든 정책 → 세션 분석 → 공통 규격 → 코드** 순서로 읽는다. 문서는 현재 지켜야 할 계약, 구현 방법, 조사 근거를 나눠 보관한다.

```text
docs/
├── README.md                     # 전체 문서 지도
├── golden/                       # 제품과 플랫폼의 공통 정본
│   ├── PROJECT-CONTEXT.md         # 사용자 요구·채택/대체된 결정
│   ├── GOLDEN-OFFICE-POLICY.md     # 공간·동료·상태·대화·소식 정책
│   └── OFFICE-OBSERVATION-PROTOCOL.md # 플랫폼 독립 관측 계약
├── development/                  # 구현·연결·검증·개발 이력
│   ├── ARCHITECTURE.md            # 실행·저장·보안 경계
│   ├── SESSION-INGESTION.md       # 수집 흐름·자체/외부 모듈·장애 분석
│   ├── OFFICE-ASSETS.md          # 가구·펫·소품 확장 계약
│   ├── MCP.md                    # 읽기 전용 도구 연결
│   ├── QA.md                     # 날짜별 검증 결과·한계
│   └── PLAN.md                   # 초기 구현 계획 이력
├── research/                     # 조사·비교·선택 근거
│   ├── RESEARCH.md               # 참고 레포·포맷·기능 후보 조사
│   ├── INGESTION-REFERENCE-AUDIT.md # 모듈별 도입/이식/제외 근거
│   └── design/                   # 날짜별 디자인 시안 카탈로그
└── images/                       # 문서 공용 합성 데모 캡처
```

| 목적 | 시작 문서 |
| --- | --- |
| 제품 방향·사용자 요구 이해 | [프로젝트 맥락](golden/PROJECT-CONTEXT.md) |
| UI나 상태의 의미 변경 | [골든 정책](golden/GOLDEN-OFFICE-POLICY.md) |
| 플랫폼 추가·공통 필드 변경 | [관측 규격](golden/OFFICE-OBSERVATION-PROTOCOL.md) |
| 세션 중복·상태·이름·수집 오류 분석 | [세션 기록 분석](development/SESSION-INGESTION.md) |
| 책상·펫·소품 꾸미기 확장 | [에셋 계약](development/OFFICE-ASSETS.md) |
| 실행 구조·저장·IPC·보안 확인 | [아키텍처](development/ARCHITECTURE.md) |
| 외부 코드 도입·업데이트 판단 | [레퍼런스 감사](research/INGESTION-REFERENCE-AUDIT.md) |
| 실행과 검증 | [루트 README](../README.md), [검증 기록](development/QA.md), [MCP 연결](development/MCP.md) |
| 시각 방향 비교 | [테마 시안](research/design/office-themes-2026-10-04.md) |

각 폴더의 [golden 안내](golden/README.md), [development 안내](development/README.md), [research 안내](research/README.md)에 문서 역할과 추가 기준을 적었다.

## 문서를 추가·수정할 때

- **golden**: 여러 구현이 공통으로 지켜야 하는 현재 정책·계약·채택한 결정. 변경 시 코드와 관련 개발 문서를 함께 갱신한다.
- **development**: 현재 코드의 동작·실행법·검증법과 날짜 있는 개발 이력. 초기 계획이나 과거 QA를 최신 제품 계약으로 해석하지 않는다.
- **research**: 비교한 대상·버전·근거·도입 여부와 미확정 후보. 후보가 채택되면 현재 계약은 golden, 구현 방법은 development에 반영하고 조사 근거를 연결한다.
- 같은 내용을 여러 정본에 복제하지 않는다. 코드와 문서가 다르면 실제 동작을 확인하고 불일치를 수정한다. 테스트 수·실제 세션 수·PID 같은 변동 값은 골든 정책에 고정하지 않는다.
- 실제 세션 원문·개인 캡처·인증정보는 Git에 넣지 않는다. 문서 이미지는 합성 데모를 사용한다.

원본 시안·생성기는 [references/design-source](../references/design-source/README.md), 실제 외부 모듈은 [vendor](../vendor), 라이선스 고지는 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md), 날짜별 작업 기록은 [update_note](../update_note.md)에 둔다. 외부 원본을 문서 폴더로 복제하지 않는다.
