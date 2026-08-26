# mirrorLog

로컬 차단된 네이버 블로그 글, 서버 거쳐 텍스트+이미지만 읽기전용으로 보는 개인용 미러 리더.

- 프런트엔드(정적 페이지): https://lkasdfkadslkj.github.io
- 백엔드(Cloudflare Worker): https://mirrorlog.qwertyuiop26338884.workers.dev

## 구조

```
사용자 <-> GitHub Pages (index.html) <-> Cloudflare Worker (worker/) <-> 네이버 블로그
```

- `index.html` — GitHub Pages 서빙 프런트엔드 전부. 완전 정적 페이지 한 장, 서버 요청/빌드 과정 없음. 블로그 URL 입력받아 AES-GCM 암호화 후 Worker `/api/read`로 전송, 응답 HTML을 권한 없는(토큰 없는) `sandbox` `<iframe srcdoc>`에 렌더링.
- `worker/` — Cloudflare Worker 소스. 네이버에 실제 요청, 받은 HTML 가공(스크립트 제거, 위험 속성 제거, 이미지/CSS/폰트 전부 Worker 경유 리라이팅) 후 반환하는 백엔드.
  - `src/index.js` — Worker 전체 로직 (HTML 리라이팅, 이미지/에셋 프록시, rate limit, 암복호화)
  - `wrangler.jsonc` — Worker 설정 (Durable Object 바인딩 포함)
  - `package.json` — devDependency `wrangler` 하나뿐

## 왜 이렇게 만들었나

- **GitHub Pages는 순수 정적 호스팅**, 서버사이드 fetch 불가. 크롤링/렌더링은 Worker 담당, GitHub Pages는 결과 표시만.
- **블로그 URL 평문 전송 안 함.** 프런트엔드에서 AES-GCM 암호화, `/api/read?d=...`로 전송, Worker 복호화. 단 정적 공개 페이지라 키도 view-source로 노출 — 원천적 한계. 브라우저 히스토리/요청 로그에 평문 URL 안 남기는 정도 방어, 완전한 비밀 아님.
- **iframe 권한 전부 없음.** `sandbox` 토큰 무(無) — 스크립트 실행, same-origin 접근, 폼 제출, 팝업, 최상위 네비게이션 전부 차단. 미러링된 글 요소 클릭 불가가 요구사항.
- **서브리소스(이미지/CSS/폰트) 전부 Worker 경유 프록시.** 초기엔 `<base href>`로 네이버 스타일시트 브라우저 직접 요청 — 프로젝트 취지(네이버 직접접속 차단 우회) 깨짐. `<link>`/CSS 내부 `url()`/`@import`까지 `/asset`, `/img` 프록시로 리라이팅하게 변경.
- **rate limit — Durable Object로 직접 구현.** Cloudflare 기본 `ratelimits` 바인딩, 이 계정에서 미동작 확인. IP당 카운팅 Durable Object로 작성 (`/read`, `/api/read` 초당 1회, `/img`, `/asset` 초당 15회).

## 배포

```bash
cd worker
npm install
npx wrangler deploy
```

`ENCRYPTION_KEY` 시크릿, 로컬 파일 없음. `wrangler secret put ENCRYPTION_KEY`로만 등록.

프런트엔드(`index.html`)는 `main` push만 하면 GitHub Pages 자동 반영.

## 알려진 한계

- 프런트엔드 AES 키, 공개 페이지 소스에 그대로 노출 (위 참고). URL 노출 감소용, 완전한 비밀 유지는 애초 불가능한 구조.
- Cloudflare Workers 무료 플랜 하루 10만 요청 한도, 계정 전체 공유. Worker 내부 rate limit으론 이 한도 자체는 못 아낌 (다운스트림 남용만 차단).
- 사진+텍스트만 지원. `<iframe>`/`<video>`/`<audio>` 임베드는 스코프 밖, 전부 제거.
