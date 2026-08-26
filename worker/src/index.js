import { DurableObject } from "cloudflare:workers";

const ALLOWED_BLOG_HOSTS = new Set(["blog.naver.com", "m.blog.naver.com"]);
const ALLOWED_IMAGE_HOST_SUFFIXES = [".pstatic.net"];
const ALLOWED_ORIGIN = "https://lkasdfkadslkj.github.io";
// The reader page used to keep a <base href="https://m.blog.naver.com/"> tag
// so relative CSS/font/icon links would still resolve — but that meant the
// viewer's own browser opened direct connections to Naver for every one of
// those, defeating the entire point of proxying through the Worker. All
// subresources referenced relative to the post now resolve against this and
// get rewritten to go through /asset or /img instead.
const NAVER_BASE = "https://m.blog.naver.com/";

function isAllowedAssetHost(hostname) {
  return ALLOWED_BLOG_HOSTS.has(hostname) || isAllowedImageHost(hostname);
}

const READER_CSS = `
<style>
  body { max-width: 720px; margin: 0 auto; padding: 24px 16px 80px;
    font-family: -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
    line-height: 1.7; font-size: 17px; color: #1a1a1a; background: #fff; }
  img, video { max-width: 100%; height: auto; display: block; margin: 12px 0; }
  a { color: inherit; }
  .mirrorlog-bar { max-width: 720px; margin: 0 auto 16px; padding: 8px 16px;
    background: #f2f2f2; border-radius: 8px; font-size: 13px; color: #666; }
  .mirrorlog-bar a { color: #03c75a; text-decoration: none; }
</style>
`;

function toMobilePostUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!ALLOWED_BLOG_HOSTS.has(url.hostname)) {
    throw new Error("허용되지 않은 호스트입니다. blog.naver.com 주소만 지원합니다.");
  }

  let blogId = url.searchParams.get("blogId");
  let logNo = url.searchParams.get("logNo");

  if (!blogId || !logNo) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      [blogId, logNo] = parts;
    }
  }

  if (!blogId || !logNo) {
    throw new Error("게시글 주소에서 blogId/logNo를 찾을 수 없습니다.");
  }

  return `https://m.blog.naver.com/${blogId}/${logNo}`;
}

function isAllowedImageHost(hostname) {
  return ALLOWED_IMAGE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

// Rewrites url(...) and @import references inside a CSS file so background
// images, fonts, and chained stylesheets also route through /asset instead
// of letting the viewer's browser fetch them straight from Naver. `baseUrl`
// is the CSS file's own URL — relative refs inside a stylesheet resolve
// against the stylesheet's location, not the HTML page's.
function rewriteCssUrls(cssText, baseUrl, workerOrigin) {
  const toProxied = (ref) => {
    const trimmed = ref.trim().replace(/^['"]|['"]$/g, "");
    if (!trimmed || trimmed.startsWith("data:")) return null;
    let abs;
    try {
      abs = new URL(trimmed, baseUrl).toString();
    } catch {
      return null;
    }
    // CSS mostly references its own kind (@import, woff/ttf fonts) through
    // here, but url() is just as often a background-image — /asset only
    // understands css/font, so anything else (icons, gif/png/jpg sprites)
    // needs to go through /img instead, which is the one that knows how to
    // validate and serve a raster image.
    const path = abs.split(/[?#]/)[0].toLowerCase();
    const endpoint = /\.(css|woff2?|ttf|otf|eot)$/.test(path) ? "asset" : "img";
    return `${workerOrigin}/${endpoint}?src=${encodeURIComponent(abs)}`;
  };

  return cssText
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, ref) => {
      const proxied = toProxied(ref);
      return proxied ? `url("${proxied}")` : match;
    })
    .replace(/@import\s+(?:url\()?(['"])([^'")]+)\1\)?/gi, (match, quote, ref) => {
      const proxied = toProxied(ref);
      return proxied ? `@import "${proxied}"` : match;
    });
}

// ---- base64url + AES-GCM helpers (mirrors the frontend's Web Crypto code) ----

function base64urlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "===".slice((b64.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function decryptUrl(d, rawKeyB64) {
  const keyBytes = Uint8Array.from(atob(rawKeyB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const combined = base64urlToBytes(d);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plainBuf);
}

// Cloudflare's built-in `ratelimits` binding turned out to be a no-op on this
// account (confirmed by testing: limit=1/10s let 5 back-to-back requests
// through) — it's documented as "permissive, eventually consistent, not an
// accurate accounting system", and evidently doesn't enforce at all here.
// A Durable Object instance is single-threaded and strongly consistent, so
// counting there actually works, and it also lets us do an exact 1-per-second
// window instead of the binding's fixed 10s/60s granularity.
export class RateLimiterDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.windowStart = 0;
    this.count = 0;
  }

  async check(limit, windowMs) {
    const now = Date.now();
    if (now - this.windowStart >= windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count++;
    return this.count <= limit;
  }
}

// `bucket` keeps /read and /img on separate counters (one page view fires
// many image requests near-simultaneously, so they need a looser allowance
// than the page-load endpoint itself).
async function checkRateLimit(env, bucket, request, limit, windowMs) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const id = env.RATE_LIMITER_DO.idFromName(`${bucket}:${ip}`);
  const stub = env.RATE_LIMITER_DO.get(id);
  return stub.check(limit, windowMs);
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
    ...extra,
  };
}

// /img and /asset only ever serve public, unauthenticated Naver static
// content (images, CSS, fonts) — never the post HTML itself — and are
// already rate-limited per IP, so there's nothing origin-locking protects
// here. It also needs to be permissive: the frontend's mirror iframe is
// fully sandboxed with no allow-same-origin, so its document has an opaque
// ("null") origin, and cross-origin font loads (@font-face) enforce CORS —
// a fixed single-origin allowlist would silently break font loading there.
function publicAssetCorsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    ...extra,
  };
}

// ---- HTML rewriting ----

function makeImageRewriter(workerOrigin) {
  return class ImageRewriter {
    element(el) {
      const lazySrc = el.getAttribute("data-lazy-src") || el.getAttribute("data-src");
      const original = lazySrc || el.getAttribute("src");
      if (!original || !original.startsWith("http")) return;

      el.setAttribute("src", `${workerOrigin}/img?src=${encodeURIComponent(original)}`);
      el.removeAttribute("data-lazy-src");
      el.removeAttribute("data-src");
      el.removeAttribute("srcset");
      // Eager, not lazy: the frontend measures the iframe's full content
      // height right after load to auto-size itself. Lazy images never
      // enter the viewport while the iframe is still height:0, so they'd
      // never load, their <img> would stay collapsed, and the height
      // measurement (and everything visually below it) would come up short.
      el.setAttribute("loading", "eager");
      el.setAttribute("referrerpolicy", "no-referrer");
    }
  };
}

class ScriptStripper {
  element(el) {
    el.remove();
  }
}

// ScriptStripper only removes <script> tags — a hostile post could still
// carry onerror/onload/onclick handlers, an <svg onload>, javascript: hrefs,
// a <meta http-equiv=refresh>, or a style="background:url(...)" pointing
// straight at Naver. Both /read and /api/read can be navigated to directly
// (not just loaded through the frontend's sandboxed iframe) — /api/read's
// `d` param is encrypted with a key that's public in the frontend JS, so an
// attacker can craft a working link to their own malicious post and send it
// straight to a victim. Belt-and-suspenders with the CSP header set on both
// responses: strip/rewrite the live vectors here so the page is inert (and
// leak-free) even if CSP were somehow bypassed or unsupported.
function makeAttributeSanitizer(workerOrigin) {
  return class AttributeSanitizer {
    element(el) {
      const toRemove = [];
      for (const [name] of el.attributes) {
        if (name.toLowerCase().startsWith("on")) toRemove.push(name);
      }
      for (const name of toRemove) el.removeAttribute(name);

      const tag = el.tagName.toLowerCase();
      if (tag === "a" || tag === "form") {
        const attr = tag === "a" ? "href" : "action";
        const val = el.getAttribute(attr);
        if (val && /^\s*javascript:/i.test(val)) el.removeAttribute(attr);
      }
      if (tag === "meta") {
        const httpEquiv = el.getAttribute("http-equiv");
        if (httpEquiv && httpEquiv.toLowerCase() === "refresh") el.remove();
      }

      const style = el.getAttribute("style");
      if (style && style.includes("url(")) {
        el.setAttribute("style", rewriteCssUrls(style, NAVER_BASE, workerOrigin));
      }
    }
  };
}

// The mobile page's top bar (logo, category dropdown, "MY메뉴" hamburger)
// depends on JS to collapse/behave correctly. With scripts stripped it just
// sits there expanded and un-styled. It's a separate site-chrome element
// from the actual post (#_post_area), so drop it rather than try to fix it.
// Also used to drop <iframe>/<video>/<audio>/<embed>/<object>: proxying
// media isn't in scope (this reader is text+images only), and left alone
// they'd have the viewer's browser connect straight to Naver/third parties.
class ElementRemover {
  element(el) {
    el.remove();
  }
}

// Only <link> tags we actually rewrite to go through /asset are worth
// keeping (stylesheets, and preloaded fonts) — everything else (icons,
// canonical, dns-prefetch/preconnect hints, preloads for other resource
// types) would just have the browser connect straight to Naver for no
// benefit to a read-only mirror, so those are dropped instead.
function makeLinkRewriter(workerOrigin) {
  return class LinkRewriter {
    element(el) {
      const href = el.getAttribute("href");
      if (!href) {
        el.remove();
        return;
      }

      const rel = (el.getAttribute("rel") || "").toLowerCase();
      const as = (el.getAttribute("as") || "").toLowerCase();
      const isStylesheet = rel === "stylesheet";
      const isFontPreload = rel === "preload" && as === "font";
      if (!isStylesheet && !isFontPreload) {
        el.remove();
        return;
      }

      let abs;
      try {
        abs = new URL(href, NAVER_BASE).toString();
      } catch {
        el.remove();
        return;
      }
      el.setAttribute("href", `${workerOrigin}/asset?src=${encodeURIComponent(abs)}`);
      el.removeAttribute("crossorigin");
      el.removeAttribute("integrity");
    }
  };
}

class HeadInjector {
  element(el) {
    el.append(READER_CSS, { html: true });
  }
}

class BodyInjector {
  constructor(sourceUrl) {
    this.sourceUrl = sourceUrl;
  }
  element(el) {
    const bar = `<div class="mirrorlog-bar">mirrorLog로 미러링된 페이지 · <a href="${this.sourceUrl}" target="_blank" rel="noopener">원문 보기</a></div>`;
    el.prepend(bar, { html: true });
  }
}

async function fetchAndRewritePost(mobileUrl, workerOrigin) {
  const upstream = await fetch(mobileUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Referer: "https://m.blog.naver.com/",
    },
  });

  if (!upstream.ok) {
    throw new Error(`원본 페이지를 불러오지 못했습니다. (status ${upstream.status})`);
  }

  const ImageRewriter = makeImageRewriter(workerOrigin);
  const LinkRewriter = makeLinkRewriter(workerOrigin);
  const AttributeSanitizer = makeAttributeSanitizer(workerOrigin);
  return new HTMLRewriter()
    .on("script", new ScriptStripper())
    .on("iframe", new ElementRemover())
    .on("video", new ElementRemover())
    .on("audio", new ElementRemover())
    .on("embed", new ElementRemover())
    .on("object", new ElementRemover())
    .on(".Ngnb", new ElementRemover())
    .on("img", new ImageRewriter())
    .on("link", new LinkRewriter())
    .on("*", new AttributeSanitizer())
    .on("head", new HeadInjector())
    .on("body", new BodyInjector(mobileUrl))
    .transform(upstream);
}

// Locks the rendered post down to inert markup even though it's served from
// our own origin: no script execution, no framing, no form submission, no
// top-level navigation away from the page. Applied to both /read and
// /api/read since either can be reached by direct navigation.
const READER_CSP = "sandbox; script-src 'none'; frame-src 'none'";

// ---- Route handlers ----

async function handleRead(request, env, workerOrigin) {
  if (!(await checkRateLimit(env, "read", request, 1, 1000))) {
    return new Response("요청이 너무 많습니다. 잠시 후 다시 시도해주세요.", { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const rawUrl = searchParams.get("url");
  if (!rawUrl) {
    return new Response("url 파라미터가 필요합니다. 예: /read?url=https://blog.naver.com/...", { status: 400 });
  }

  let mobileUrl;
  try {
    mobileUrl = toMobilePostUrl(rawUrl);
  } catch (err) {
    return new Response(err.message, { status: 400 });
  }

  let transformed;
  try {
    transformed = await fetchAndRewritePost(mobileUrl, workerOrigin);
  } catch (err) {
    return new Response(err.message, { status: 502 });
  }

  return new Response(transformed.body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Content-Security-Policy": READER_CSP,
    },
  });
}

// Same as handleRead, but the target URL arrives AES-GCM encrypted in `d`
// (decrypted server-side) instead of sitting in the query string as plaintext,
// and the response carries CORS headers so a separate static frontend
// (GitHub Pages) can fetch() it cross-origin.
async function handleApiRead(request, env, workerOrigin) {
  if (!(await checkRateLimit(env, "read", request, 1, 1000))) {
    return new Response("요청이 너무 많습니다. 잠시 후 다시 시도해주세요.", { status: 429, headers: corsHeaders() });
  }

  const { searchParams } = new URL(request.url);
  const d = searchParams.get("d");
  if (!d) {
    return new Response("d 파라미터가 필요합니다.", { status: 400, headers: corsHeaders() });
  }

  let rawUrl;
  try {
    rawUrl = await decryptUrl(d, env.ENCRYPTION_KEY);
  } catch {
    return new Response("복호화에 실패했습니다.", { status: 400, headers: corsHeaders() });
  }

  let mobileUrl;
  try {
    mobileUrl = toMobilePostUrl(rawUrl);
  } catch (err) {
    return new Response(err.message, { status: 400, headers: corsHeaders() });
  }

  let transformed;
  try {
    transformed = await fetchAndRewritePost(mobileUrl, workerOrigin);
  } catch (err) {
    return new Response(err.message, { status: 502, headers: corsHeaders() });
  }

  return new Response(transformed.body, {
    status: 200,
    headers: corsHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": READER_CSP,
    }),
  });
}

async function handleImage(request, env) {
  if (!(await checkRateLimit(env, "img", request, 15, 1000))) {
    return new Response("요청이 너무 많습니다. 잠시 후 다시 시도해주세요.", {
      status: 429,
      headers: publicAssetCorsHeaders(),
    });
  }

  const { searchParams } = new URL(request.url);
  const src = searchParams.get("src");
  if (!src) {
    return new Response("src 파라미터가 필요합니다.", { status: 400 });
  }

  let target;
  try {
    target = new URL(src);
  } catch {
    return new Response("잘못된 이미지 주소입니다.", { status: 400 });
  }

  if (!isAllowedImageHost(target.hostname)) {
    return new Response("허용되지 않은 이미지 호스트입니다.", { status: 403 });
  }

  const upstream = await fetch(target.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Referer: "https://blog.naver.com/",
    },
  });

  if (!upstream.ok) {
    return new Response("이미지를 불러오지 못했습니다.", { status: 502 });
  }

  // pstatic.net is Naver's user-upload CDN, so upstream Content-Type isn't
  // trustworthy — if it ever served text/html (or an svg, which can carry
  // <script>) at this URL, blindly forwarding it would make this endpoint
  // serve arbitrary HTML from our own origin. Only allow real raster images
  // through, and lock the response down defensively even so.
  const ct = upstream.headers.get("Content-Type") || "";
  if (!/^image\//i.test(ct) || /svg/i.test(ct)) {
    return new Response("이미지가 아닙니다.", { status: 415 });
  }

  const headers = new Headers(publicAssetCorsHeaders());
  headers.set("Content-Type", ct);
  headers.set("Cache-Control", "public, max-age=86400");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "sandbox; default-src 'none'");

  return new Response(upstream.body, { status: 200, headers });
}

const FONT_MIME_BY_EXT = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
};

// Proxies the stylesheets/fonts a mirrored post's <link> tags point at, so
// the viewer's browser never opens a direct connection to Naver just to
// render the page (see LinkRewriter/rewriteCssUrls — this is the other half
// of that: without it, the rewritten hrefs would 404).
async function handleAsset(request, env, workerOrigin) {
  if (!(await checkRateLimit(env, "asset", request, 15, 1000))) {
    return new Response("요청이 너무 많습니다. 잠시 후 다시 시도해주세요.", {
      status: 429,
      headers: publicAssetCorsHeaders(),
    });
  }

  const { searchParams } = new URL(request.url);
  const src = searchParams.get("src");
  if (!src) {
    return new Response("src 파라미터가 필요합니다.", { status: 400 });
  }

  let target;
  try {
    target = new URL(src);
  } catch {
    return new Response("잘못된 리소스 주소입니다.", { status: 400 });
  }

  if (!isAllowedAssetHost(target.hostname)) {
    return new Response("허용되지 않은 리소스 호스트입니다.", { status: 403 });
  }

  const upstream = await fetch(target.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Referer: "https://m.blog.naver.com/",
    },
  });

  if (!upstream.ok) {
    return new Response("리소스를 불러오지 못했습니다.", { status: 502 });
  }

  const headers = new Headers(publicAssetCorsHeaders());
  headers.set("Cache-Control", "public, max-age=86400");
  headers.set("X-Content-Type-Options", "nosniff");

  // Never forward upstream's Content-Type verbatim (same reasoning as
  // /img) — decide the outgoing type ourselves from the path extension, and
  // reject anything that isn't a stylesheet or a recognized font format.
  const path = target.pathname.toLowerCase();
  const ct = upstream.headers.get("Content-Type") || "";
  if (/^text\/css/i.test(ct) || path.endsWith(".css")) {
    const cssText = await upstream.text();
    headers.set("Content-Type", "text/css; charset=utf-8");
    return new Response(rewriteCssUrls(cssText, target, workerOrigin), { status: 200, headers });
  }

  const fontExt = path.match(/\.(woff2|woff|ttf|otf|eot)$/)?.[1];
  if (fontExt) {
    headers.set("Content-Type", FONT_MIME_BY_EXT[fontExt]);
    return new Response(upstream.body, { status: 200, headers });
  }

  return new Response("지원하지 않는 리소스 형식입니다.", { status: 415 });
}

const HOME_PAGE = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mirrorLog</title>
${READER_CSS}
</head>
<body>
<h1>mirrorLog</h1>
<p>네이버 블로그 글 주소를 넣으면 텍스트와 이미지만 뽑아서 보여줍니다.</p>
<p style="font-size:13px;color:#888;">프런트엔드: <a href="${ALLOWED_ORIGIN}" target="_blank" rel="noopener">${ALLOWED_ORIGIN}</a></p>
<form action="/read" method="get" style="display:flex; gap:8px;">
  <input type="url" name="url" placeholder="https://blog.naver.com/아이디/글번호" required
    style="flex:1; padding:10px; font-size:15px;">
  <button type="submit" style="padding:10px 16px;">보기 (직접 테스트용)</button>
</form>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const workerOrigin = url.origin;

    if (request.method === "OPTIONS" && url.pathname === "/api/read") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method === "OPTIONS" && (url.pathname === "/img" || url.pathname === "/asset")) {
      return new Response(null, { status: 204, headers: publicAssetCorsHeaders() });
    }

    if (url.pathname === "/") {
      return new Response(HOME_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/read") {
      return handleRead(request, env, workerOrigin);
    }
    if (url.pathname === "/api/read") {
      return handleApiRead(request, env, workerOrigin);
    }
    if (url.pathname === "/img") {
      return handleImage(request, env);
    }
    if (url.pathname === "/asset") {
      return handleAsset(request, env, workerOrigin);
    }
    return new Response("Not found", { status: 404 });
  },
};
