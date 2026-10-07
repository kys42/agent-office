# 사무실 에셋과 꾸미기 확장 계약

2026-10-07 · [골든 정책](../golden/GOLDEN-OFFICE-POLICY.md) · [개발 문서 지도](README.md)

현재 구현은 원본 세션을 바꾸지 않고 표현을 바꾸는 에셋 경계와 캐릭터·색상·장식 선택 및 저장 UI를 제공한다. 도구 기본 캐릭터는 설정에서, 개별 동료는 업무 카드의 ‘이 동료 꾸미기’에서 바꾼다. 가구 꾸미기·구매 UI는 후속 범위다.

## 현재 구조

| 책임 | 위치 | 계약 |
| --- | --- | --- |
| 에셋 목록·버전 | [office-assets.ts](../../src/shared/office-assets.ts) | stable asset ID, 가구 종류, 펫 sheet/walk 경로·mood 행 |
| 가구 prefab | [Furniture.tsx](../../src/components/Furniture.tsx) | desk/chair/equipment/helper/sofa/bed. 장식이며 세션 선택은 바깥 상호작용 요소가 담당 |
| 캐릭터 목록·설정 | [pets.ts](../../src/shared/pets.ts) | 도구와 독립적인 캐릭터·색·장식 카탈로그, stable colleague key, 버전·복구·부분 변경 병합 |
| 캐릭터 renderer | [Sprite.tsx](../../src/components/Sprite.tsx) | context의 기본 모습 + 동료별 override, mood, size, walk/direction, 몸·장식의 독립 PNG 레이어 |
| 꾸미기 UI | [PetCustomizer.tsx](../../src/components/PetCustomizer.tsx) | 저장 전 초안, 8가지 상태·걷기 미리보기, 취소·기본값 복구·저장 실패 안내 |
| 스타일 | [pets.css](../../src/styles/pets.css), [office.css](../../src/styles/office.css) | 꾸미기 화면과 사무실 그림·상태 효과 |
| 공간 좌표 | [office-layout.ts](../../src/shared/office-layout.ts) | 프로젝트 구역·공동 책상·개인 자리·보조 책상의 위치. 에셋 색과 무관 |
| 휴식 장면 | [RestLounge.tsx](../../src/components/RestLounge.tsx) | 프로젝트 이름표·독립 가구·펫·이름·복귀 동작 |

`OfficeAppearance`에는 oak/lilac/sea 팔레트, petHue, cup/plant/none 소품을 정의한다. 가구별 `appearance`와 Sprite의 `hue` props로 적용하며 scene에서 둘을 조합한다. DOM의 `data-asset-id`는 테스트와 제작 도구에서 조각을 찾는 안정적 단서다. 같은 책상 프리팹은 width를 받아 공동 책상으로 늘어난다. 배치 정보는 inline 좌표, 색 정보는 프리팹에 국한된 CSS 변수다.

이 가구들은 CSS로 그리는 독립 프리팹이고 캐릭터는 PNG sprite 에셋이다. 모든 가구가 개별 PNG로 내보내져 있다는 뜻은 아니다. 새 PNG/SVG 가구를 도입해도 동일한 좌표·슬롯·상호작용 계약에 연결한다. 사무실 바닥에 가구를 한 장으로 굽지 않는다. 펫 애니메이션 행 변경은 기존 mood 매핑의 호환성을 고려해 에셋 버전을 올린다.

## 꾸미기 저장 규칙

1. 저장 키는 일회성 로그 경로나 대표 run ID 대신 **동료 키**를 쓴다. 일반 세션은 canonical Session.id, persona는 `actor:<actor.id>`. 재수집·새 대화로 색과 애착 대상이 사라지지 않게 한다.
2. 프로젝트 공동 책상의 표면은 benchKey 단위, 개인 의자/펫/소품은 동료 키 단위로 저장한다. 한 명의 선택이 공동 책상 전체에 적용되는지 UI에 명시한다.
3. 사용자 꾸미기는 원본 관측과 별도 appearance 저장소에 버전과 함께 둔다. 원본 로그/DB, canonical ID, runtime 상태, 사용량을 수정하지 않는다.
4. 새 스킨은 기존 bounding box, 발 위치, 좌석 중심, 부모 옆 보조 자리 크기를 준수한다. 현재 좌표/이름표/말풍선을 가리지 않게 한다. 미등록 asset/잘못된 색은 기본 스킨으로 복구한다.
5. 상태는 색만으로 전달하지 않는다. 작업 중 텍스트·모니터·호출 아이콘과 접근 가능한 이름은 꾸미기 후에도 남긴다. hue는 캐릭터 그림에만 적용하고 상태 배지까지 돌리지 않는다.
6. 장식 소품과 실제 작업 근거를 구분한다. 화분을 놓는 것이 특정 도구 실행, 작업 성공, 권한 승인을 뜻하지 않는다.
7. 모션 감소·배경 탭 정책, 개인정보 모드, 큰 화면/미니/라운지에서 같은 선택을 일관되게 적용한다. 영속 저장·초기화·미등록 값 복구는 단위 테스트, 미니·라운지·모바일·취소는 UI 테스트로 확인한다.

## 캐릭터 꾸미기 v1

기존 코코·네모·집게에 말랑(슬라임), 코딩냥(안경 쓴 개발자 고양이), 돌돌(조약돌), 삐코(레트로 로봇), 몽실(구름 정령)을 추가했다. 공급자와 그림은 독립적이므로 Claude에도 슬라임이나 로봇을 고를 수 있다. 원래 색·민트·복숭아·라벤더·하늘·버터의 6가지 색과 기본 모습·베레모·왕관·새싹·리본·안경을 제공한다. 코딩냥의 기본 안경과 기존 캐릭터의 고유 장식은 ‘기본 모습’에 포함된다.

`Preferences.petAppearance`는 `{ version: 1, providers, colleagues }` 형태다. 기존 SQLite settings.preferences에 관측과 별도로 저장하며 원본 세션 JSON이나 개인 alias/notes를 변경하지 않는다. `providers[provider]`가 기본값이고 `colleagues[petKey(session)]`가 전체 모습을 덮어쓴다. actor 동료는 다른 run에서도 같은 키를 쓴다.

저장 시 변경한 키만 RPC로 보내고 store에서 두 record를 병합한다. `null`은 해당 override를 삭제하는 명령이며 영속 값에서는 제거한다. 개별 초기화는 현재 도구 기본값으로 돌아가고, 도구 초기화는 해당 공급자의 원래 캐릭터로 돌아간다. 다른 동료·다른 도구의 설정은 보존한다. 쓰기 RPC는 enum·버전·길이·항목 수를 검증한다. 읽기는 알 수 없는 버전이나 캐릭터·색·장식을 기본 모습으로 복구한다.

데모는 `office:demo-pets` localStorage에 별도로 저장하므로 실연결 설정과 섞이지 않는다. 사무실, 보조 책상, 명단, 검색, 활동, 상세, 소식, 명령 팔레트, 라운지, 보관, 데스크 펫·한 줄 사무실·바닥 책상·팝업 업무 카드는 각 창의 appearance context를 사용하며 session을 Sprite에 전달한다. 공통 useOffice가 저장·방송·데모 설정을 관리하며 이름·색·장식은 영어/한국어 카탈로그의 현재 언어로 읽는다. 상태 배지·공급자 이름·프로젝트 배치는 꾸미기와 독립적이다.

### 그림과 제작

`scripts/generate-pets.py`는 원본 생성기를 수정하지 않고 기존 3종의 몸 색 팔레트를 새로 렌더링하며, 새 4종을 32px 픽셀 그림으로 제작한다. 4열 × 8 mood 행과 4열 × 3 walk 행, 발 위치 `(16, 30)`을 유지한다. 장식은 같은 프레임의 움직임에 맞춘 별도 투명 시트여서 몸 색이 모자·노트북에 번지지 않는다. Sprite의 CSS 모션 감소와 배경 중지 규칙이 두 레이어에 똑같이 적용된다.

슬라임은 요청한 [반려주식 원본](../../references/pets/banryeojusik/README.md)을 고정 커밋에서 가져왔다. 128px 원본을 104px로 일괄 nearest 축소해 128px 프레임에 배치한다. 32px로 줄이지 않아 원본 표정의 디테일을 유지하면서, 모자 여유 공간과 사무실 발 위치를 맞춘다. 원본에 없는 방향별 뒤·옆 자세는 만들었다고 주장하지 않으며 3방향 모두 hop을 공유한다.

[캐릭터 비교 이미지](../../public/sprites/character-preview.png) · [단위 테스트](../../tests/pets.test.ts) · [화면 테스트](../../tests/ui/pets.spec.ts)

향후 후보는 책상 재질, 펫 팔레트, 의자 색, 화분/컵/스탠드 슬롯, 프로젝트 러그, 애착 별명이다. 임의 스크립트나 외부 URL을 실행하는 사용자 에셋 로더는 현재 범위에 포함하지 않는다.


### 요청/집중 장식

`effects.css`(공통 부품 `DeskEffects.tsx`)의 불꽃·땀·김·불똥·서류 더미·날아오는 서류는 원본 펫/책상 좌표를 바꾸지 않는 CSS 장식이다. `stationSpeech().arrival`, `focusLevel`, `deskPapers`를 사용한다. 애니메이션은 transform·opacity만 쓴다(항상 떠 있는 독의 다시 그리기 비용). 모션 감소·background에서는 정지하며, 실제 명령 실행 성공이나 연속 작업 시간을 보장하지 않는다.
