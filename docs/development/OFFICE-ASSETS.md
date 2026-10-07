# 사무실 에셋과 꾸미기 확장 계약

2026-10-05 · [골든 정책](../golden/GOLDEN-OFFICE-POLICY.md) · [개발 문서 지도](README.md)

현재 구현은 원본 세션을 바꾸지 않고 표현을 바꾸는 에셋 경계를 제공한다. 아직 색상 선택·구매·드래그 배치·꾸미기 저장 UI는 없다. 이후 기능을 구현된 것으로 읽지 않는다.

## 현재 구조

| 책임 | 위치 | 계약 |
| --- | --- | --- |
| 에셋 목록·버전 | [office-assets.ts](../../src/shared/office-assets.ts) | stable asset ID, 가구 종류, 펫 sheet/walk 경로·mood 행 |
| 가구 prefab | [Furniture.tsx](../../src/components/Furniture.tsx) | desk/chair/equipment/helper/sofa/bed. 장식이며 세션 선택은 바깥 상호작용 요소가 담당 |
| 캐릭터 renderer | [Sprite.tsx](../../src/components/Sprite.tsx) | provider 캐릭터, mood, size, walk/direction, hue. 원본 PNG를 파괴적으로 수정하지 않음 |
| 스타일 | [resident-life.css](../../src/resident-life.css) | 에셋별 CSS 변수와 그림·상태 효과 |
| 공간 좌표 | [office-layout.ts](../../src/shared/office-layout.ts) | 프로젝트 구역·공동 책상·개인 자리·보조 책상의 위치. 에셋 색과 무관 |
| 휴식 장면 | [RestLounge.tsx](../../src/components/RestLounge.tsx) | 프로젝트 이름표·독립 가구·펫·이름·복귀 동작 |

`OfficeAppearance`에는 oak/lilac/sea 팔레트, petHue, cup/plant/none 소품을 정의한다. 가구별 `appearance`와 Sprite의 `hue` props로 적용하며 scene에서 둘을 조합한다. DOM의 `data-asset-id`는 테스트와 제작 도구에서 조각을 찾는 안정적 단서다. 같은 책상 프리팹은 width를 받아 공동 책상으로 늘어난다. 배치 정보는 inline 좌표, 색 정보는 프리팹에 국한된 CSS 변수다.

이 가구들은 CSS로 그리는 독립 프리팹이고 캐릭터는 PNG sprite 에셋이다. 모든 가구가 개별 PNG로 내보내져 있다는 뜻은 아니다. 새 PNG/SVG 가구를 도입해도 동일한 좌표·슬롯·상호작용 계약에 연결한다. 사무실 바닥에 가구를 한 장으로 굽지 않는다. 펫 애니메이션 행 변경은 기존 mood 매핑의 호환성을 고려해 에셋 버전을 올린다.

## 이후 꾸미기 저장 시 지킬 규칙

1. 저장 키는 일회성 로그 경로나 대표 run ID 대신 **동료 키**를 쓴다. 일반 세션은 canonical Session.id, persona는 `actor:<actor.id>`. 재수집·새 대화로 색과 애착 대상이 사라지지 않게 한다.
2. 프로젝트 공동 책상의 표면은 benchKey 단위, 개인 의자/펫/소품은 동료 키 단위로 저장한다. 한 명의 선택이 공동 책상 전체에 적용되는지 UI에 명시한다.
3. 사용자 꾸미기는 원본 관측과 별도 appearance 저장소에 버전과 함께 둔다. 원본 로그/DB, canonical ID, runtime 상태, 사용량을 수정하지 않는다.
4. 새 스킨은 기존 bounding box, 발 위치, 좌석 중심, 부모 옆 보조 자리 크기를 준수한다. 현재 좌표/이름표/말풍선을 가리지 않게 한다. 미등록 asset/잘못된 색은 기본 스킨으로 복구한다.
5. 상태는 색만으로 전달하지 않는다. 작업 중 텍스트·모니터·호출 아이콘과 접근 가능한 이름은 꾸미기 후에도 남긴다. hue는 캐릭터 그림에만 적용하고 상태 배지까지 돌리지 않는다.
6. 장식 소품과 실제 작업 근거를 구분한다. 화분을 놓는 것이 특정 도구 실행, 작업 성공, 권한 승인을 뜻하지 않는다.
7. 모션 감소·배경 탭 정책, 개인정보 모드, 큰 화면/미니/라운지에서 같은 선택을 일관되게 적용한다. 실제 꾸미기 기능 도입 때 영속 저장·초기화·마이그레이션 테스트를 추가한다.

향후 후보는 책상 재질, 펫 팔레트, 의자 색, 화분/컵/스탠드 슬롯, 프로젝트 러그, 애착 별명이다. 임의 스크립트나 외부 URL을 실행하는 사용자 에셋 로더는 현재 범위에 포함하지 않는다.


### 요청/집중 장식

`effects.css`(공통 부품 `DeskEffects.tsx`)의 불꽃·땀·김·불똥·서류 더미·날아오는 서류는 원본 펫/책상 좌표를 바꾸지 않는 CSS 장식이다. `stationSpeech().arrival`, `focusLevel`, `deskPapers`를 사용한다. 애니메이션은 transform·opacity만 쓴다(항상 떠 있는 독의 다시 그리기 비용). 모션 감소·background에서는 정지하며, 실제 명령 실행 성공이나 연속 작업 시간을 보장하지 않는다.
