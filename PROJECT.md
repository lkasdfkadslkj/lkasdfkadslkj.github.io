# mirrorLog

로컬에서 차단된 네이버 블로그 글을, 서버를 하나 거쳐서 텍스트+이미지만 읽기 전용으로 볼 수 있게 해주는 개인용 미러 리더.

- 프런트엔드(정적 페이지): https://lkasdfkadslkj.github.io
- 백엔드(Cloudflare Worker): https://mirrorlog.qwertyuiop26338884.workers.dev

## 구조

```
사용자 <-> GitHub Pages (index.html) <-> Cloudflare Worker (worker/) <-> 네이버 블로그
```

- `index.html` — 이 저장소가 GitHub Pages로 서빙하는 프런트엔드 전부. 완전 정적 페이지 한 장이고, 서버 요청이나 빌드 과정이 없다. 블로그 URL을 입력받아 AES-GCM으로 암호화한 뒤 Worker의 `/api/read`로 보내고, 돌아온 HTML을 `sandbox` 속성만 걸린(아무 권한도 부여하지 않은) `<iframe srcdoc>`에 그대로 렌더링한다.
- `worker/` — Cloudflare Worker 소스. 실제로 네이버에 요청을 보내고, 받아온 HTML을 가공(스크립트 제거, 위험 속성 제거, 이미지/CSS/폰트를 전부 Worker 경유로 리라이팅)해서 돌려주는 백엔드.
  - `src/index.js` — Worker 전체 로직 (HTML 리라이팅, 이미지/에셋 프록시, rate limit, 암복호화)
  - `wrangler.jsonc` — Worker 설정 (Durable Object 바인딩 포함)
  - `package.json` — `wrangler` 하나만 devDependency로 있음

## 왜 이렇게 만들었나

- **GitHub Pages는 순수 정적 호스팅**이라 서버 사이드에서 외부 URL을 fetch할 수 없다. 그래서 실제 크롤링/렌더링은 Cloudflare Worker가 담당하고, GitHub Pages는 그 결과를 보여주는 화면 역할만 한다.
- **입력한 블로그 URL은 평문으로 안 보낸다.** 프런트엔드에서 AES-GCM으로 암호화해서 `/api/read?d=...`로 보내고 Worker가 복호화한다. 다만 이 페이지는 정적 공개 페이지라 암호화 키도 view-source로 보이는 게 원천적 한계 — URL이 브라우저 히스토리/요청 로그에 평문으로 안 남게 하는 정도의 방어일 뿐, 완전한 비밀은 아니다.
- **iframe은 아무 것도 허용하지 않는다.** `sandbox` 속성에 토큰을 하나도 안 줘서 스크립트 실행, same-origin 접근, 폼 제출, 팝업, 최상위 네비게이션이 전부 막혀 있다. 화면에 보이는 미러링된 글의 어떤 요소도 클릭이 안 되는 게 요구사항이었기 때문.
- **모든 서브리소스(이미지, CSS, 폰트)를 Worker 경유로 프록시한다.** 처음엔 `<base href>`로 네이버 스타일시트를 브라우저가 직접 받아오게 했었는데, 그러면 애초에 이 프로젝트를 만든 이유(네이버 직접 접속 차단 우회)가 깨져서, `<link>`/CSS 내부 `url()`/`@import`까지 전부 `/asset`, `/img` 프록시로 리라이팅하도록 바꿨다.
- **rate limit은 Durable Object로 직접 구현했다.** Cloudflare의 기본 `ratelimits` 바인딩이 이 계정에서는 실제로 동작하지 않는 걸 확인해서, IP당 카운팅을 Durable Object로 직접 짰다 (`/read`, `/api/read`는 초당 1회, `/img`, `/asset`은 초당 15회).

## 배포

```bash
cd worker
npm install
npx wrangler deploy
```

`ENCRYPTION_KEY` 시크릿은 로컬 파일로 존재하지 않고 `wrangler secret put ENCRYPTION_KEY`로만 등록되어 있다.

프런트엔드(`index.html`)는 그냥 `main` 브랜치에 push하면 GitHub Pages가 알아서 반영한다.

## 알려진 한계

- 프런트엔드의 AES 키는 공개 페이지 소스에 그대로 노출된다 (위 설명 참고). URL 노출을 줄이는 용도지, 완전한 비밀 유지는 애초에 불가능한 구조.
- Cloudflare Workers 무료 플랜의 하루 10만 요청 한도는 계정 전체 공유라, Worker 안의 rate limit으로도 그 한도 자체를 아낄 수는 없다 (다운스트림 남용만 막는다).
- 사진+텍스트만 지원한다. `<iframe>`/`<video>`/`<audio>` 임베드는 스코프 밖이라 전부 제거한다.
