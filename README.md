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


## Vercel 배포

이 프로젝트는 로컬에서는 `playwright`, Vercel에서는 `playwright-core` + `@sparticuz/chromium` 조합으로 동작하도록 설정되어 있습니다.

### 준비

```bash
npm install
npm run build
```

### 배포

1. GitHub 저장소를 Vercel에 연결합니다.
2. Framework Preset은 `Other`로 둡니다.
3. Install Command는 기본값 `npm install`을 사용합니다.
4. Build Command는 비워두거나 `npm run build`를 사용합니다.
5. Output Directory는 지정하지 않습니다.

### 참고

- Notion 파싱은 서버 함수에서 Playwright를 실행하므로 첫 응답이 다소 느릴 수 있습니다.
- Vercel 함수 제한 시간 안에서만 동작하므로, 매우 긴 Notion 페이지는 로컬 실행이 더 안정적일 수 있습니다.
