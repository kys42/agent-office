# 이미지 제작 기록

브랜드 이미지는 built-in `image_gen`으로 생성했다. 실제 앱 캡처와 분리해 사용한다. 개인 세션, 실제 프로젝트 경로, 계정명, 접속 코드를 입력에 넣지 않았다.

## night-shift-illustration.png

- 용도: 블로그 커버·SNS 일러스트 배경, 1536×1024.
- 대체 텍스트: 남색 밤 배경 앞에서 주황 고양이, 작은 로봇, 빨간 가재 동료가 이어진 나무 책상에서 일하는 픽셀 일러스트. 로봇은 질문하고 가재는 완료 서류를 들고 있다.
- 입력: 신규 생성, 참조 이미지 없음.
- 프롬프트 핵심: `ads-marketing; Agent Office conceptual editorial illustration, not a screenshot; crisp pixel art; connected honey wooden desks; orange cat with teal headband, charcoal robot with cyan eyes, red lobster; question and completion cues; tiny helper desk; calm ink navy upper negative space; cream/amber/mint/terracotta palette; no written text, logos, fake UI or watermark`.

## little-team-illustration.png

- 용도: 세로 브랜드 포스터, 1024×1536.
- 대체 텍스트: 고양이는 타이핑하고 로봇은 질문하고 가재는 완료 서류를 든 작은 팀의 세로 픽셀 일러스트.
- 입력: 신규 생성, 참조 이미지 없음.
- 프롬프트 핵심: `ads-marketing; portrait Agent Office conceptual illustration, not UI; orange cat with teal headband typing, charcoal robot with question bubble, red lobster with completed sheet; connected wooden desks, paper trolley, warm lamp; crisp pixel art; upper 35% ink navy space for typography; no words, logos, graphs, fake chrome or watermark`.

## 실제 UI와 편집 가능한 최종 카드

`assets/capture.json`이 실제 캡처 commit·시각·viewport의 정본이다. `?demo`의 합성 데이터만 사용했고 DOM 텍스트나 기능을 홍보용으로 교체하지 않았다. 애니메이션을 줄여 정지 캡처했다.

| 내보낸 이미지 | 크기 | 대체 텍스트 |
| --- | --- | --- |
| social-cover.png | 1536×1024 | 내 AI 팀에도 사무실이 생겼다. 이어진 책상의 픽셀 동료 브랜드 일러스트 |
| social-poster.png | 1080×1620 | AI는 일하는데 나는 창을 순찰 중? 내 코딩 동료들을 바탕화면의 작은 팀으로 |
| social-team.png | 1080×1350 | 같은 프로젝트, 옆자리 동료. 실제 앱의 합성 프로젝트 구역과 책상 |
| social-conversation.png | 1080×1350 | 무슨 일을 하는지 말이 보이게. 실제 앱의 합성 요청·진행 대화 카드 |

재생성:

```bash
# 별도 테스트 데이터 프로필의 개발 서버가 실행 중이어야 한다.
SCREENSHOT_URL=http://127.0.0.1:5339 node scripts/marketing-captures.mjs
# 레포 안의 이미지와 HTML만 읽어 PNG를 만든다. 네트워크 접근 불필요.
node scripts/marketing-render.mjs
```

문구는 생성 이미지 원본을 수정하지 않고 `campaign.html`의 편집 가능한 글자로 올렸다. 웹폰트·외부 이미지 요청 없이 로컬 원본으로 렌더링한다. OS 한글 글꼴에 따라 줄바꿈/렌더링이 조금 달라질 수 있으므로 내보낸 PNG를 눈으로 확인한다.
