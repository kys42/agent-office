# 디자인 시스템 — 순정 맥(Sonoma) 셸

2026-10-09 · Issue #73. [네이티브 테마 Round 03](../research/design/native-themes-2026-10-08.md)의 선택안 ‘순정 맥’을 실제 앱에 적용한 기준이다. 제품 의미는 [골든 계약](../golden/README.md)을 따르고, 이 문서는 표현만 다룬다.

## 원칙

- 창 크롬은 macOS 앱처럼 조용하게, 색은 픽셀 사무실과 동료가 가진다.
- 라이트가 기본이고 시스템이 다크면 다크로 바뀐다(`prefers-color-scheme`). 앱 안에 별도 모양 설정은 두지 않는다.
- 시스템 글꼴(SF/Apple SD Gothic Neo, 그 외 Pretendard)과 시스템 파랑 강조색. 픽셀 글꼴(Galmuri)은 사무실 장면 안에서만 쓴다.

## 구조

| 영역 | 구현 | 메모 |
| --- | --- | --- |
| 사이드바(소스 목록) | `App.tsx` `.sidebar` | 공간(사무실·라운지·보관) / 할 일(기다려요·결과·작업 중) / 프로젝트 / 기록 / 하단 연결·설정·가이드·데모 전환. 데스크탑에서는 신호등이 이 위에 놓이고 브랜드는 숨긴다 |
| 통합 툴바 | `App.tsx` `.toolbar.app-header` | 화면 제목·부제, `#toolbar-slot`, 검색(⌘K), 소식·사용량·가리기·데스크 펫 버튼 |
| 공간 전환 | `OfficeWorkspace` `stage-toolbar` | `createPortal`로 툴바 슬롯에 들어가는 세그먼트 컨트롤. 슬롯이 없으면 제자리에 그린다 |
| 오른쪽 열 | 명단·업무 카드·소식함·사용량 | 같은 폭(`--dock-w`)과 툴바 높이(`--bar-h`)의 머리줄, 회색 그룹 배경 위 흰 카드 |
| 사이드바 ↔ 사무실 | `onZoneChange`, `projectRequest` props | 현재 공간을 사이드바·제목에 비추고(첫 값은 저장된 공간), 프로젝트를 누르면 명단을 그 프로젝트로 정확히 한정한다(지울 수 있는 토큰). 가구 좌표는 바뀌지 않는다 |

## 토큰과 파일

- `src/styles/tokens.css`: 라이트/다크 토큰. 기존 이름(`--bg-0…5`, `--line*`, `--text*`, `--accent*`, `--st-*`)을 유지해 모든 스타일이 따라온다. 새 의미 토큰: `--sidebar`, `--sidebar-tint`, `--grouped`, `--field`, `--control*`, `--selection`, `--scene-backdrop`, `--hud`, `--badge`, `--face-*`.
- `src/styles/shell.css`: 창 그리드·사이드바·툴바·배너·시트(모달)·페이지 틀.
- `src/styles/native.css`: 마지막에 불러오는 네이티브 층. 데스크 펫·책상 줄(`body.dock-mode`)은 바탕화면 위 HUD라 시스템 모양과 관계없이 어두운 토큰을 쓴다. 컨테이너 쿼리는 `.main-content`가 아닌 툴바에 건다(본문에 걸면 페이지 안 고정 위치 대화상자가 메인 열에 갇힌다). 그룹 목록, 세그먼트 탭, Messages식 대화, Spotlight식 팔레트, 카드 창 팝오버. 툴바는 **콘텐츠 열 폭 기준** 컨테이너 쿼리로 줄어든다(오른쪽 패널이 열리면 검색 → 아이콘, 개수·부제 숨김).
- 장면(`office.css` 방·책상·말풍선, `speech.css`, `effects.css`)의 색은 픽셀 아트라 토큰으로 바꾸지 않는다. 대기 라운지는 창 안의 밤 방으로 유지한다.

## 데스크탑 창

`desktop/main.ts`: macOS에서 `vibrancy: 'sidebar'`, 투명 창 배경, 신호등 `{ x: 18, y: 20 }`. `body.is-mac`이면 사이드바만 반투명(`--sidebar-tint`)으로 시스템 재질이 비치고 콘텐츠 열은 불투명하다. 그 외 플랫폼은 단색 배경.

## 변경할 때

- 새 크롬 색은 리터럴 대신 토큰을 쓰고 라이트/다크 둘 다 확인한다.
- 툴바에 버튼을 늘리면 1050px 창 + 오른쪽 패널 열림에서 겹치지 않는지 본다.
- 검증: `tests/ui/native.spec.ts`(사이드바 공간·할 일·프로젝트, 툴바 슬롯, 시스템 모양), 기존 UI 테스트, `scripts/desktop-smoke.mjs`.
