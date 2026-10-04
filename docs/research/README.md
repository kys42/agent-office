# 리서치 문서 — 조사와 선택 근거

[전체 문서 지도](../README.md) · [골든 계약](../golden/README.md)

| 문서 | 책임 |
| --- | --- |
| [참고 저장소 조사](RESEARCH.md) | 조사 대상·고정 커밋·확인 범위, 포맷 차이와 기능 후보 |
| [세션 수집 레퍼런스 감사](INGESTION-REFERENCE-AUDIT.md) | 모듈별 직접 사용·정책 이식·제외 판단, 실패 원인과 도입 기준 |
| [2026-10-04 테마 시안](design/office-themes-2026-10-04.md) | 독립 9안과 비교 근거, 채택 여부 |

조사 시점·대상 버전·확인한 범위를 함께 남긴다. 소개만 본 레포를 코드 분석·직접 도입한 것처럼 표현하지 않는다. 조사 결과가 채택되면 [golden](../golden/README.md)에 계약을, [development](../development/README.md)에 실제 구현을 기록하고 이 근거를 연결한다.

`design/`은 날짜별 카탈로그와 manifest 사본을 보관한다. manifest 안의 preview·asset 상대 경로는 [실행 시안 폴더](../../public/design/office-themes-2026-10-04/README.md) 기준이다. 비교용 테마 전체가 제품에 채택됐다는 뜻은 아니다. 외부 원본은 `references/`·`vendor/`, 전체 조사 clone은 Git에서 제외된 `.research/`에 둔다.
