'use strict';
// Resolves an aggregator match page (or a bare embed page) to the raw HLS
// manifest URL plus the Referer the CDN expects.
//
// Strategy, in order:
//   1. Load the page in headless Chromium and watch every frame's network
//      traffic for a manifest (content-type mpegurl, .m3u8 in the URL, or a
//      body that starts with #EXTM3U). The frame that requested it gives us
//      the referer.
//   2. If nothing shows up, poke the player (click the video, play buttons,
//      the iframe itself) and keep watching.
//   3. If still nothing, pull every inline script out of every frame and
//      run it through a sandboxed VM with hls.js / jwplayer / video stubs
//      that capture whatever URL the script tries to play. On top of that a
//      brute-force decoder tries hex -> atob -> XOR for every single-byte
//      key, which is the obfuscation these embeds use today.
//   4. Verify the manifest actually serves with that referer, and try a few
//      other candidates if it does not.

const { chromium } = require('playwright-core');
const vm = require('node:vm');
const { findBrowser, NO_BROWSER_MSG } = require('./browsers');

const NAV_TIMEOUT = 30000;   // ms to wait for the page's first response
const CAPTURE_WAIT = 5000;   // ms to watch the network before decoding scripts
const POKE_WAIT = 6000;      // ms to watch after poking the player
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Resource types that never carry a manifest. Skipping them makes the page
// load much faster and starves most of the ad scripts.
const SKIP_TYPES = new Set(['image', 'font', 'media', 'stylesheet']);
// Iframes that sit on match pages but never carry the stream: chat and
// social widgets. They must not win the "player iframe" pick.
const NOT_PLAYER_RE = /youtube\.com\/live_chat|youtube\.com\/embed|twitter\.com|x\.com\/i\/|facebook\.com\/plugins|disqus\.com|discord\.com\/widget|google\.com\/recaptcha|challenges\.cloudflare\.com|telegram\.org/i;
const AD_HOST_RE = /(doubleclick|googlesyndication|adsystem|adnxs|popads|propellerads|exoclick|juicyads|trafficjunky|adsterra|hilltopads|onclick|clickadu|a-ads|mgid|taboola|outbrain|revcontent|zeropark|richads|adcash|pushground)\./i;

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    const found = findBrowser();
    if (!found) return Promise.reject(Object.assign(new Error(NO_BROWSER_MSG), { code: 'NO_BROWSER' }));
    browserPromise = chromium.launch({
      headless: true,
      executablePath: found.exe,
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-blink-features=AutomationControlled'],
    }).then((b) => {
      b.on('disconnected', () => { browserPromise = null; });
      return b;
    }).catch((e) => { browserPromise = null; throw e; });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  if (b) await b.close().catch(() => {});
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

function looksLikeManifestUrl(url) {
  return /\.m3u8(\?|$|#)/i.test(url) || /\/playlist\b|\/manifest\b|\/master\b|\/index\b/i.test(url) && /m3u8|hls|chatgpt/i.test(url);
}

function isMasterPlaylist(text) {
  return /#EXT-X-STREAM-INF/i.test(text);
}

function manifestLooksComplete(text) {
  if (!text || !text.trim().startsWith('#EXTM3U')) return false;
  // A master playlist needs at least one variant; a media playlist needs at
  // least one segment. A bare #EXTM3U header is the "truncated" failure mode.
  return /#EXT-X-STREAM-INF/i.test(text) || /#EXTINF/i.test(text);
}

async function fetchManifest(url, referer, { timeout = 8000 } = {}) {
  const headers = { 'User-Agent': UA, 'Accept': '*/*' };
  if (referer) { headers.Referer = referer; headers.Origin = referer.replace(/\/$/, ''); }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, complete: manifestLooksComplete(text) };
  } catch (e) {
    return { ok: false, status: 0, text: '', complete: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Fallback: decode obfuscated URLs found in inline scripts.

function bruteDecode(hexOrB64) {
  const out = [];
  const tryPush = (s) => { if (/^https?:\/\/\S{6,}/i.test(s)) out.push(s.trim()); };

  let bin = null;
  // hex pairs -> chars
  if (/^[0-9a-f]+$/i.test(hexOrB64) && hexOrB64.length % 2 === 0) {
    let s = '';
    for (let i = 0; i < hexOrB64.length; i += 2) s += String.fromCharCode(parseInt(hexOrB64.slice(i, i + 2), 16));
    bin = s;
    tryPush(s);
  }
  const b64s = [hexOrB64];
  if (bin) b64s.push(bin);
  for (const b of b64s) {
    if (!/^[A-Za-z0-9+/=_-]+$/.test(b) || b.length < 8) continue;
    let dec;
    try { dec = Buffer.from(b.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1'); } catch { continue; }
    if (!dec) continue;
    tryPush(dec);
    tryPush([...dec].reverse().join(''));
    // single-byte XOR over every key; the real one lights up as http
    for (let k = 1; k < 256; k++) {
      let s = '';
      for (let i = 0; i < dec.length; i++) s += String.fromCharCode(dec.charCodeAt(i) ^ k);
      if (s.startsWith('http')) { tryPush(s); tryPush([...s].reverse().join('')); }
      else {
        const r = [...s].reverse().join('');
        if (r.startsWith('http')) tryPush(r);
      }
    }
  }
  return [...new Set(out)];
}

function decodeFromScripts(scripts) {
  const found = [];
  for (const src of scripts) {
    // plain manifest URLs
    for (const m of src.matchAll(/https?:\/\/[^\s"'`<>()]+\.m3u8[^\s"'`<>()]*/gi)) found.push(m[0]);
    // long hex / base64 literals
    for (const m of src.matchAll(/["'`]([0-9a-fA-F]{40,}|[A-Za-z0-9+/=_-]{32,})["'`]/g)) {
      for (const u of bruteDecode(m[1])) found.push(u);
    }
  }
  return [...new Set(found)];
}

// Run an inline script inside a sandbox whose player APIs record the source
// they are handed. This is the "evaluate it in a JS VM" fallback.
function vmExtract(scriptSource) {
  const player = [];   // handed to a player API: Hls.loadSource, video.src, jwplayer file
  const other = [];    // anything else that got a URL: fetch, xhr, setAttribute
  const NOT_MEDIA = /\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico|html?)(\?|$)/i;
  const record = (u, isPlayer) => {
    if (typeof u !== 'string' || !/^https?:\/\//i.test(u) || NOT_MEDIA.test(u)) return;
    (isPlayer ? player : other).push(u);
  };

  // Anything the page script asks of an element that we did not stub gets a
  // no-op function back, so a call like el.style.setProperty() cannot throw.
  const noop = () => {};
  const forgiving = (obj) => new Proxy(obj, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k !== 'string' || k === 'then' || k === 'toJSON') return undefined;
      return noop;
    },
  });
  const makeEl = () => {
    const el = {
      style: forgiving({}), dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      children: [], childNodes: [], attributes: {},
      addEventListener() {}, removeEventListener() {}, appendChild(c) { return c; }, removeChild() {}, insertBefore() {},
      setAttribute(k, v) { el.attributes[k] = v; if (k === 'src') record(String(v)); }, getAttribute(k) { return el.attributes[k] ?? null; },
      querySelector() { return makeEl(); }, querySelectorAll() { return []; }, getElementsByTagName() { return []; },
      play() { return Promise.resolve(); }, pause() {}, load() {}, canPlayType() { return ''; }, focus() {}, click() {},
      getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
      innerHTML: '', textContent: '', parentNode: null, parentElement: null,
    };
    Object.defineProperty(el, 'src', { set(v) { record(String(v), true); }, get() { return ''; } });
    return forgiving(el);
  };

  class Hls {
    static isSupported() { return true; }
    constructor() {}
    loadSource(u) { record(u, true); }
    attachMedia() {}
    on() {}
    once() {}
    off() {}
    destroy() {}
    startLoad() {}
    static get Events() { return new Proxy({}, { get: (_, k) => String(k) }); }
    static get ErrorTypes() { return new Proxy({}, { get: (_, k) => String(k) }); }
  }
  const jwInstance = { setup(cfg) { if (cfg) { record(cfg.file, true); (cfg.sources || cfg.playlist || []).forEach((s) => record(s && (s.file || s.src), true)); } return jwInstance; }, on() { return jwInstance; }, play() {}, remove() {} };
  const clapprPlayer = function (cfg) { if (cfg) { record(cfg.source, true); (cfg.sources || []).forEach((s) => record(typeof s === 'string' ? s : s && s.source, true)); } return { on() {}, play() {} }; };
  const videojs = function () { return { src(s) { if (typeof s === 'string') record(s, true); else if (s) record(s.src, true); }, ready(f) { try { f(); } catch {} }, on() {}, play() {}, hlsQualitySelector() {} }; };
  videojs.registerPlugin = () => {};

  const doc = makeEl();
  doc.getElementById = () => makeEl();
  doc.createElement = () => makeEl();
  doc.body = makeEl(); doc.head = makeEl(); doc.documentElement = makeEl();
  doc.readyState = 'complete';
  doc.cookie = '';
  doc.location = { href: '', hostname: '', origin: '', protocol: 'https:', search: '' };
  doc.referrer = '';

  const sandbox = {
    atob: (s) => Buffer.from(s, 'base64').toString('latin1'),
    btoa: (s) => Buffer.from(s, 'latin1').toString('base64'),
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout: (f) => { try { typeof f === 'function' && f(); } catch {} return 1; },
    setInterval: () => 1, clearTimeout() {}, clearInterval() {},
    requestAnimationFrame: () => 1,
    document: doc,
    navigator: { userAgent: UA, language: 'en-US', platform: 'Win32', plugins: [] },
    location: { href: '', hostname: '', origin: '', protocol: 'https:', search: '', hash: '' },
    screen: { width: 1920, height: 1080 },
    crypto: { getRandomValues: (a) => a, randomUUID: () => '00000000-0000-4000-8000-000000000000', subtle: {} },
    performance: { now: () => 0, mark() {}, measure() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: (u) => { record(String(u)); return new Promise(() => {}); },
    XMLHttpRequest: function () { return { open: (_, u) => record(String(u)), send() {}, setRequestHeader() {}, addEventListener() {} }; },
    Hls, jwplayer: () => jwInstance, Clappr: { Player: clapprPlayer }, videojs,
    TextDecoder, TextEncoder, escape, unescape,
    addEventListener() {}, removeEventListener() {}, postMessage() {}, alert() {}, open() {}, MutationObserver: function () { return { observe() {}, disconnect() {} }; },
    Image: function () { return makeEl(); }, Audio: function () { return makeEl(); },
    dispatchEvent() {}, matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720,
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox; sandbox.top = sandbox; sandbox.parent = sandbox;
  // The context keeps its own Promise and microtask queue, drained inside
  // runInContext, so a rejection in a page script's .then() lands in this
  // try/catch instead of killing the process as an unhandled rejection.
  const ctx = vm.createContext(sandbox, { microtaskMode: 'afterEvaluate' });
  try { vm.runInContext(scriptSource, ctx, { timeout: 1500 }); } catch { /* scripts often reference APIs we don't stub; that's fine */ }
  // Player captures win outright. Loose captures only count if they look like a manifest.
  return [...new Set([...player, ...other.filter((u) => /m3u8|hls|playlist|manifest/i.test(u))])];
}

// ---------------------------------------------------------------------------

async function collectFrameScripts(page, log = () => {}) {
  const out = [];
  for (const frame of page.frames()) {
    let scripts = [];
    try {
      scripts = await frame.evaluate(() => Array.from(document.scripts).filter((s) => !s.src && s.textContent.trim().length > 20).map((s) => s.textContent));
    } catch (e) {
      // A frame that navigated away or got detached is normal. Anything
      // else means page scripting itself is broken, which is worth seeing.
      const msg = String(e && e.message || e).split('\n')[0];
      if (!/detached|navigat|destroyed|closed/i.test(msg)) log(`could not read scripts from ${frame.url().slice(0, 60)}: ${msg}`);
      continue;
    }
    out.push({ frameUrl: frame.url(), scripts });
  }
  return out;
}

// Click the things that usually start a player: the video itself, play
// overlays, and the centre of every iframe that is large enough to be one.
async function pokePlayer(page, log) {
  for (const frame of page.frames()) {
    try {
      const done = await frame.evaluate(() => {
        const cand = [
          ...document.querySelectorAll('video'),
          ...document.querySelectorAll('[class*="play" i], [id*="play" i], .vjs-big-play-button, .jw-icon-display, .plyr__control--overlaid, button'),
        ];
        let n = 0;
        for (const el of cand.slice(0, 8)) {
          try { el.click(); n++; } catch {}
          if (el.tagName === 'VIDEO') { el.muted = true; el.play && el.play().catch(() => {}); }
        }
        return n;
      });
      if (done) log(`poked ${done} element(s) in ${frame.url().slice(0, 60)}`);
    } catch { /* cross-origin or gone */ }
  }
  try {
    const boxes = await page.$$eval('iframe', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; }));
    for (const b of boxes) {
      if (b.w > 200 && b.h > 120) { await page.mouse.click(b.x, b.y).catch(() => {}); }
    }
  } catch {}
}

async function findPlayerFrames(page) {
  // Every iframe on the page, biggest first. Ad frames get pushed to the end.
  let items = [];
  try {
    items = await page.$$eval('iframe', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { src: e.src || e.getAttribute('data-src') || '', w: r.width, h: r.height }; }));
  } catch {}
  items = items.filter((i) => i.src && !i.src.startsWith('about:') && !NOT_PLAYER_RE.test(i.src));
  if (!items.length) {
    // The DOM query can miss iframes that are still loading or were built
    // by script. The frame tree knows about them regardless.
    items = page.frames()
      .filter((f) => f !== page.mainFrame() && /^https?:/.test(f.url()) && !NOT_PLAYER_RE.test(f.url()))
      .map((f) => ({ src: f.url(), w: 1, h: 1 }));
  }
  return items
    .sort((a, b) => (b.w * b.h) - (a.w * a.h))
    .sort((a, b) => (AD_HOST_RE.test(a.src) ? 1 : 0) - (AD_HOST_RE.test(b.src) ? 1 : 0));
}

/**
 * @param {string} inputUrl
 * @param {(msg: string) => void} [onLog]
 * @returns {Promise<{ m3u8: string, referer: string, embedUrl: string, pageUrl: string, method: string, title: string, log: string[] }>}
 */
async function resolve(inputUrl, onLog) {
  const log = [];
  const say = (m) => { log.push(m); if (onLog) onLog(m); };
  const t0 = Date.now();

  let target;
  try { target = new URL(inputUrl.trim()).href; } catch { throw Object.assign(new Error('That does not look like a URL. Paste the full match page link, starting with http.'), { code: 'BAD_URL' }); }

  // Playwright sends page.evaluate callbacks as their source text. A build
  // that strips it (pkg bytecode) can only catch streams that appear on the
  // wire by themselves, so say so up front instead of failing quietly later.
  if (/\[native code\]/.test(String(() => 0))) say('warning: this build lost its function source, so script decoding and player poking will not work. Rebuild with --no-bytecode.');

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
  });
  context.setDefaultTimeout(NAV_TIMEOUT);

  const candidates = []; // { url, referer, frameUrl, hasBody, complete, master, at }
  const seen = new Set();

  await context.route('**/*', (route) => {
    const req = route.request();
    if (SKIP_TYPES.has(req.resourceType())) return route.abort();
    if (AD_HOST_RE.test(req.url())) return route.abort();
    return route.continue();
  });

  const page = await context.newPage();
  // Popups (popunders) get closed the moment they appear. Pages we open on
  // purpose (the direct embed load) register themselves in ownPages.
  const ownPages = new Set([page]);
  context.ownPages = ownPages;
  context.on('page', (p) => { if (!ownPages.has(p)) p.close().catch(() => {}); });

  const noteCandidate = (url, referer, frameUrl, extra = {}) => {
    if (seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, referer, frameUrl, at: Date.now() - t0, ...extra });
    say(`manifest candidate: ${url}`);
  };

  // Child-frame documents that came back as errors: the player site takes
  // its event pages down outside the game window, and then the aggregator's
  // iframe points at a 404.
  const frameErrors = new Map();

  context.on('response', async (res) => {
    const req = res.request();
    const url = res.url();
    if (req.resourceType() === 'document' && res.status() >= 400) {
      const fr = req.frame();
      if (fr && fr !== page.mainFrame()) frameErrors.set(url, res.status());
    }
    const ct = (res.headers()['content-type'] || '').toLowerCase();
    const byType = ct.includes('mpegurl') || ct.includes('x-mpegurl');
    const byUrl = looksLikeManifestUrl(url);
    if (!byType && !byUrl && !(ct.includes('text') || ct.includes('octet') || ct === '')) return;
    if (!byType && !byUrl && req.resourceType() === 'document') return;
    let body = '';
    try {
      // Only pull bodies for responses that could plausibly be a manifest.
      const len = Number(res.headers()['content-length'] || 0);
      if (!byType && !byUrl && len > 200000) return;
      body = (await res.text()).slice(0, 4000);
    } catch { /* body unavailable (redirect, aborted) */ }
    if (byType || byUrl || body.trim().startsWith('#EXTM3U')) {
      const headers = req.headers();
      const referer = headers.referer || headers.Referer || '';
      const frame = req.frame();
      noteCandidate(url, referer, frame ? frame.url() : '', {
        hasBody: !!body, complete: manifestLooksComplete(body), master: isMasterPlaylist(body), status: res.status(),
      });
    }
  });
  context.on('requestfailed', (req) => {
    if (looksLikeManifestUrl(req.url())) {
      const h = req.headers();
      noteCandidate(req.url(), h.referer || '', req.frame() ? req.frame().url() : '', { hasBody: false, complete: false, failed: true });
    }
  });

  let title = '';
  let embedUrl = target;
  let method = 'network';

  try {
    say(`loading ${target}`);
    try {
      // 'commit' returns as soon as the page starts arriving. Aggregator
      // pages hang on third-party scripts for ages; the network watch below
      // does not need the DOM to settle first.
      await page.goto(target, { waitUntil: 'commit' });
    } catch (e) {
      throw Object.assign(new Error(`Could not load the page: ${e.message.split('\n')[0]}`), { code: 'PAGE_LOAD' });
    }
    title = (await page.title().catch(() => '')) || '';

    const waitForCandidate = async (ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (candidates.some((c) => c.complete || c.hasBody)) return true;
        await page.waitForTimeout(250);
      }
      return candidates.length > 0;
    };

    // Let the DOM settle briefly so the iframe scan sees the player.
    await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});

    // Step 1: just watch.
    await waitForCandidate(CAPTURE_WAIT);

    // Work out which frame is the player, for the report and for the referer.
    // The DOM may still be settling right after 'commit', so scan twice.
    let frames = await findPlayerFrames(page);
    if (!frames.length) { await page.waitForTimeout(700); frames = await findPlayerFrames(page); }
    const playerFrame = frames.find((f) => !AD_HOST_RE.test(f.src));
    if (playerFrame) {
      embedUrl = playerFrame.src;
      say(`player iframe: ${embedUrl}`);
    } else if (page.frames().length <= 1) {
      say('no player iframe on this page, treating it as the embed itself');
    }

    const decodeScripts = async () => {
      const frameScripts = await collectFrameScripts(page, say);
      // Prefer the player frame's scripts, then everything else.
      frameScripts.sort((a, b) => (a.frameUrl === embedUrl ? -1 : 0) - (b.frameUrl === embedUrl ? -1 : 0));
      for (const { frameUrl, scripts } of frameScripts) {
        const urls = new Set();
        for (const s of scripts) for (const u of vmExtract(s)) urls.add(u);
        for (const u of decodeFromScripts(scripts)) urls.add(u);
        for (const u of urls) noteCandidate(u, originOf(frameUrl) ? originOf(frameUrl) + '/' : '', frameUrl, { hasBody: false, complete: false, decoded: true });
        if (urls.size) return true;
      }
      return false;
    };

    // Step 2: decode inline scripts. No side effects, so it runs before any
    // clicking: a click on the player usually sends the iframe off to an ad.
    // This also finds the stream slot when the game is not live yet and the
    // player's own request came back 404.
    if (!candidates.length) {
      say('no manifest on the wire yet, decoding inline scripts');
      if (await decodeScripts()) method = 'script';
    }

    // Step 3: poke and watch again, then decode once more.
    if (!candidates.length) {
      say('nothing decoded, poking the player');
      await pokePlayer(page, say);
      await waitForCandidate(POKE_WAIT);
      if (!candidates.length && await decodeScripts()) method = 'script';
    }

    // Some player frames open the real player in a nested iframe that only
    // exists after the click; one more scan of iframes for a deeper embed.
    if (!candidates.length && playerFrame) {
      say('following the player iframe directly');
      const inner = await resolveEmbedDirect(context, playerFrame.src, say);
      if (inner) { candidates.push(inner); method = inner.method; }
    }

    if (!candidates.length) {
      const dead = playerFrame && ([...frameErrors.entries()].find(([u]) => u === playerFrame.src || u.startsWith(playerFrame.src)) || null);
      if (dead) {
        const host = originOf(playerFrame.src) ? new URL(playerFrame.src).host : 'the player site';
        throw Object.assign(new Error(`The match page points at a player on ${host}, but that page is down right now (${host} answered ${dead[1]}). The player site only puts the game up around kickoff, so there is nothing to grab yet. Try again close to game time, or turn on Watch for kickoff and the app will keep trying.`), { code: 'EMBED_DOWN', retryable: true, embedUrl: playerFrame.src });
      }
      const hint = playerFrame
        ? `The player iframe (${embedUrl}) loaded but never fetched a playable HLS manifest, and its scripts did not decode to a stream URL. Most often that means the site has not put the stream up yet: try again a few minutes before kickoff. If the game is already on, the site may have changed its player.`
        : 'No player iframe was found on that page and no HLS manifest was requested. Check the link is the match page (not the site home or a listing), or paste the embed URL directly.';
      throw Object.assign(new Error(hint), { code: playerFrame ? 'NO_MANIFEST' : 'NO_IFRAME' });
    }

    // Rank: complete bodies first, masters before media, earliest first.
    candidates.sort((a, b) => (b.complete - a.complete) || (b.master - a.master) || (a.at - b.at));
    const best = candidates[0];
    // If the iframe scan came up empty, the frame that requested the
    // manifest is the embed.
    if (embedUrl === target && best.frameUrl && best.frameUrl !== target && /^https?:/.test(best.frameUrl)) {
      embedUrl = best.frameUrl;
      say(`player frame: ${embedUrl}`);
    }

    // Referer: what the browser actually sent, else the frame's origin, else the embed's origin.
    const refCandidates = [];
    const push = (r) => { if (r && !refCandidates.includes(r)) refCandidates.push(r); };
    push(best.referer);
    push(originOf(best.frameUrl) && originOf(best.frameUrl) + '/');
    push(originOf(embedUrl) && originOf(embedUrl) + '/');
    push(originOf(target) && originOf(target) + '/');
    // Normalise to origin + slash; the CDN checks the host, not the path.
    const normalised = [...new Set(refCandidates.map((r) => (originOf(r) ? originOf(r) + '/' : r)))];

    say('verifying the manifest plays with that referer');
    let chosen = null;
    let lastProbe = null;
    for (const r of normalised) {
      const probe = await fetchManifest(best.url, r);
      lastProbe = probe;
      if (probe.complete) { chosen = r; break; }
      say(`referer ${r} -> ${probe.status || probe.error || 'no body'}${probe.text ? ` (${probe.text.length} bytes)` : ''}`);
    }
    // status: 'live' (manifest verified), 'not-live' (host has nothing at
    // that slot yet), 'wrong-referer' (truncated manifest), 'unverified'.
    let verified = true;
    let status = 'live';
    let reason = '';
    if (!chosen) {
      const bare = await fetchManifest(best.url, '');
      if (bare.complete) { chosen = ''; say('manifest serves without any referer'); }
      else {
        verified = false;
        chosen = normalised[0] || '';
        const st = lastProbe ? lastProbe.status : 0;
        const truncated = lastProbe && lastProbe.text.trim().startsWith('#EXTM3U');
        if (st === 404) {
          status = 'not-live';
          reason = 'The stream host has nothing at this slot yet (404). That usually means the game is not live; the slot tends to go up a few minutes before kickoff.';
        } else if (truncated) {
          status = 'wrong-referer';
          reason = 'The host answered with a truncated manifest, so it wants a different Referer. Edit the Referer field and press Test.';
        } else {
          status = 'unverified';
          reason = `The manifest did not verify (${st || (lastProbe && lastProbe.error) || 'no reply'}). mpv may still play it; press Test to see what the host says.`;
        }
        say(`warning: ${reason}`);
      }
    }

    return {
      m3u8: best.url,
      referer: chosen,
      embedUrl,
      pageUrl: target,
      method,
      verified,
      status,
      reason,
      title: title.replace(/\s+/g, ' ').trim(),
      elapsedMs: Date.now() - t0,
      candidates: candidates.map((c) => ({ url: c.url, referer: c.referer, complete: !!c.complete })),
      log,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

// Load an embed URL in its own page (used when the aggregator wraps the
// player in a frame that refuses to play while embedded).
async function resolveEmbedDirect(context, url, say) {
  const pagePromise = context.newPage();
  // Register before the 'page' event can fire, or the popup guard closes it.
  const page = await pagePromise;
  if (context.ownPages) context.ownPages.add(page);
  let found = null;
  const onResp = async (res) => {
    if (found) return;
    const ct = (res.headers()['content-type'] || '').toLowerCase();
    if (ct.includes('mpegurl') || looksLikeManifestUrl(res.url())) {
      let body = '';
      try { body = (await res.text()).slice(0, 4000); } catch {}
      const h = res.request().headers();
      found = { url: res.url(), referer: h.referer || originOf(url) + '/', frameUrl: url, hasBody: !!body, complete: manifestLooksComplete(body), master: isMasterPlaylist(body), at: 0, method: 'network' };
    }
  };
  page.on('response', onResp);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', referer: undefined });
    for (let i = 0; i < 20 && !found; i++) await page.waitForTimeout(250);
    if (!found) {
      await pokePlayer(page, say);
      for (let i = 0; i < 20 && !found; i++) await page.waitForTimeout(250);
    }
    if (!found) {
      const scripts = (await collectFrameScripts(page, say)).flatMap((f) => f.scripts);
      const urls = new Set();
      for (const s of scripts) for (const u of vmExtract(s)) urls.add(u);
      for (const u of decodeFromScripts(scripts)) urls.add(u);
      const first = [...urls][0];
      if (first) found = { url: first, referer: originOf(url) + '/', frameUrl: url, hasBody: false, complete: false, decoded: true, at: 0, method: 'script' };
    }
  } catch (e) {
    say(`embed load failed: ${e.message.split('\n')[0]}`);
  } finally {
    await page.close().catch(() => {});
  }
  return found;
}

module.exports = { resolve, closeBrowser, warm: () => getBrowser().catch(() => {}), fetchManifest, bruteDecode, vmExtract, manifestLooksComplete };
