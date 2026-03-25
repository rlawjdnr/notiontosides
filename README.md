# notion-live-presentation-downloadable

공개 Notion 링크를 실제 브라우저 렌더링으로 읽어서 divider 기준 슬라이드로 분리하고, 발표용 화면과 standalone HTML 저장 기능을 제공하는 로컬 웹앱입니다.

## 요구 환경

- Node.js 18 이상
- Playwright Chromium 브라우저 설치

## 설치

```bash
npm install
npx playwright install chromium
```

## 실행

```bash
npm start
```

브라우저에서 아래 주소를 엽니다.

```txt
http://localhost:3040
```

쿼리 파라미터도 바로 지원합니다.

```txt
http://localhost:3040/?url=https://www.notion.so/your-public-page
http://localhost:3040/?url=https://www.notion.so/your-public-page&autoRefresh=true
```

## 동작 방식

- 백엔드가 Playwright로 공개 Notion 페이지를 실제 렌더링합니다.
- DOM에서 블록 구조를 추출합니다.
- `divider` 블록을 기준으로 슬라이드를 분리합니다.
- 프론트엔드는 고정된 발표용 배율로 렌더링합니다.
- 슬라이드 내용이 길면 해당 슬라이드 내부에서만 스크롤됩니다.
- 현재 덱은 self-contained HTML로 저장할 수 있습니다.

## 키보드

- `Right`, `PageDown`, `Space`: 다음 슬라이드
- `Left`, `PageUp`: 이전 슬라이드
- `Home`: 표지 슬라이드
- `R`: 현재 링크 다시 불러오기
- `Esc`: 숨겨진 툴바 다시 표시
