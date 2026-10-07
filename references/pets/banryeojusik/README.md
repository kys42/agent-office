# 반려주식 슬라임 원본

사용자 요청에 따라 같은 소유자의 [kys42/banryeojusik](https://github.com/kys42/banryeojusik) 프로젝트에서 가져왔다.

- 고정 커밋: `b45866ceda1e4a7e327a46a93a077fb09c396ada`
- 원본 위치: `public/generated/slime-ai-atlas*.png`, `slime-ai-atlas.json`
- 포함 팔레트: 기본 leaf, mint, apricot, violet, sky, honey. 앱에서는 원래 색·민트·복숭아·라벤더·하늘·버터로 표시.
- 원본 PNG와 manifest는 변경 없이 보존한다. 원본 코드·계좌·주식 데이터는 가져오지 않는다.

`scripts/generate-pets.py`가 128px 원본을 공통 104px nearest 크기로 축소하고 128px 프레임에 배치해 모자 여유 공간과 발 위치를 맞춘다. 사무실의 4열 × 8행 상태 시트로 재배열하고, 사무실 노트북·말풍선 기호를 별도 합성한다. 32px로 줄이지 않아 원본 표정의 디테일을 유지한다. 모자는 manifest의 각 프레임 content top을 따라 별도 투명 시트로 제작한다.

슬라임 원본에는 뒤·옆 그림이 없으므로 세 걷기 방향은 기존 hop 애니메이션을 공유한다. `leave`도 hop과 가방 소품을 조합한다. 다른 캐릭터의 32px 시트와 동일한 정규화 좌석·발 기준을 사용한다.

재생성: `uv run --with pillow scripts/generate-pets.py` (Pillow 12.3.0으로 검증).
