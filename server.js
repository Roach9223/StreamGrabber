'use strict';
// StreamGrabber: local server + UI window.
//   node server.js            starts on 127.0.0.1 and opens the UI window
//   node server.js --no-open  starts without opening anything
//   node server.js --port N   use a fixed port (default 47811)

// pkg's Node build has no inspector module, and playwright-core requires
// it at load time. Hand it a stub so the exe can start. Real Node keeps
// the real module.
if (process.pkg) {
  const Module = require('node:module');
  const origLoad = Module._load;
  const stub = { url: () => undefined, open() {}, close() {}, waitForDebugger() {}, console: globalThis.console, Session: class { connect() {} connectToMainThread() {} disconnect() {} post(_m, _p, cb) { if (typeof _p === 'function') _p(null, {}); else if (cb) cb(null, {}); } on() {} once() {} off() {} } };
  Module._load = function (request, ...rest) {
    if (request === 'inspector' || request === 'node:inspector' || request === 'inspector/promises' || request === 'node:inspector/promises') return stub;
    return origLoad.call(this, request, ...rest);
  };
}

// A stray async error anywhere (a page script misbehaving inside the
// resolver's sandbox, say) must not take the whole app down.
process.on('unhandledRejection', (e) => { console.error('ignored async error:', (e && e.message) || e); });

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { resolve, closeBrowser, fetchManifest, warm } = require('./resolver');
const { findBrowser } = require('./browsers');

const args = process.argv.slice(2);
const NO_OPEN = args.includes('--no-open');
const PORT = Number(args[args.indexOf('--port') + 1]) || 47811;
const PUBLIC = path.join(__dirname, 'public');
const IS_EXE = !!process.pkg;

// Packaged exe: the node binary is a console app, so the first process
// relaunches itself with the console hidden and exits. --console keeps it.
if (IS_EXE && !args.includes('--console') && !args.includes('--hidden')) {
  // pkg treats a spawn of its own exe as "run a script with embedded Node"
  // unless PKG_EXECPATH is already set, so set it to keep app mode.
  const child = spawn(process.execPath, [...args, '--hidden'], {
    detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, PKG_EXECPATH: 'StreamGrabber' },
  });
  child.on('spawn', () => { child.unref(); process.exit(0); });
  child.on('error', (e) => { console.error('could not relaunch hidden:', e.message); process.exit(1); });
  // Keep this process alive until one of those fires.
  setInterval(() => {}, 1000);
  return;
}

// ---------------------------------------------------------------------------
// Config: %LOCALAPPDATA%\StreamGrabber\config.json

const CONFIG_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'StreamGrabber');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// Hidden runs have no console, so console output also goes to a log file.
if (args.includes('--hidden')) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const logStream = fs.createWriteStream(path.join(CONFIG_DIR, 'streamgrabber.log'), { flags: 'a' });
    const write = (level) => (...a) => { try { logStream.write(`${new Date().toISOString()} ${level} ${a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}
`); } catch {} };
    console.log = write('info'); console.error = write('error'); console.warn = write('warn');
    process.on('uncaughtException', (e) => { console.error(e); });
  } catch {}
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ---------------------------------------------------------------------------
// mpv

const MPV_CANDIDATES = [
  'C:\\Program Files\\MPV Player\\mpv.exe',
  'C:\\Program Files\\mpv\\mpv.exe',
  'C:\\Program Files (x86)\\mpv\\mpv.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'mpv', 'mpv.exe'),
  path.join(os.homedir(), 'scoop', 'apps', 'mpv', 'current', 'mpv.exe'),
  'C:\\ProgramData\\chocolatey\\bin\\mpv.exe',
];

function findMpv(cfg) {
  if (cfg.mpvPath && fs.existsSync(cfg.mpvPath)) return { path: cfg.mpvPath, found: true, source: 'config' };
  for (const p of MPV_CANDIDATES) if (p && fs.existsSync(p)) return { path: p, found: true, source: 'auto' };
  try {
    const out = execFileSync('where.exe', ['mpv.exe'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).find(Boolean);
    if (out && fs.existsSync(out)) return { path: out, found: true, source: 'path' };
  } catch {}
  return { path: cfg.mpvPath || '', found: false, source: 'none' };
}

function psQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }

function buildMpvArgs(m3u8, referer) {
  const a = ['--no-ytdl'];
  if (referer) a.push(`--http-header-fields=Referer: ${referer}`);
  a.push(m3u8);
  return a;
}
function buildCommandLine(mpvPath, m3u8, referer) {
  return ['&', psQuote(mpvPath), ...buildMpvArgs(m3u8, referer).map((x) => (x.startsWith('--') && !x.includes(' ') ? x : psQuote(x)))].join(' ');
}

// ---------------------------------------------------------------------------
// HTTP helpers

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain' };

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((ok, fail) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { fail(e); } });
    req.on('error', fail);
  });
}
function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

function state() {
  const cfg = loadConfig();
  return { mpv: findMpv(cfg), last: cfg.last || null, history: cfg.history || [], configPath: CONFIG_PATH };
}

function remember(cfg, entry) {
  cfg.last = entry;
  const hist = (cfg.history || []).filter((h) => h.m3u8 !== entry.m3u8);
  hist.unshift(entry);
  cfg.history = hist.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Routes

let busy = false;

// The page keeps an SSE connection open. When the last one drops and
// nothing reconnects within a few seconds, the window was closed and the
// app quits. Watching the browser process is not enough: Edge's first
// process hands off to a second one and exits straight away.
let uiConnections = 0;
let uiCloseTimer = null;
function uiAttached(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
  res.write('event: hi\ndata: {}\n\n');
  uiConnections++;
  clearTimeout(uiCloseTimer);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
  req.on('close', () => {
    clearInterval(ping);
    uiConnections = Math.max(0, uiConnections - 1);
    if (uiConnections === 0 && !NO_OPEN) {
      clearTimeout(uiCloseTimer);
      uiCloseTimer = setTimeout(() => { if (uiConnections === 0) { console.log('UI window closed'); shutdown(); } }, 4000);
    }
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  // Only the UI page may talk to the API. Blocks random websites from
  // poking a localhost server through the browser.
  if (p.startsWith('/api/')) {
    const origin = req.headers.origin || '';
    const host = req.headers.host || '';
    if (origin && !origin.endsWith(host)) return json(res, 403, { error: 'forbidden' });
  }

  if (req.method === 'GET' && p === '/api/state') return json(res, 200, state());
  if (req.method === 'GET' && p === '/api/alive') return uiAttached(req, res);

  if (req.method === 'GET' && p === '/api/resolve') {
    const target = url.searchParams.get('url') || '';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
    const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    if (busy) { send('error', { code: 'BUSY', message: 'A conversion is already running. Give it a few seconds.' }); return res.end(); }
    busy = true;
    try {
      const r = await resolve(target, (m) => send('log', { message: m }));
      const cfg = loadConfig();
      remember(cfg, { pageUrl: r.pageUrl, embedUrl: r.embedUrl, m3u8: r.m3u8, referer: r.referer, title: r.title, at: new Date().toISOString() });
      saveConfig(cfg);
      send('done', r);
    } catch (e) {
      send('error', { code: e.code || 'ERR', message: e.message });
    } finally {
      busy = false;
      res.end();
    }
    return;
  }

  if (req.method === 'POST' && p === '/api/check') {
    const { m3u8, referer } = await readBody(req);
    if (!m3u8) return json(res, 400, { error: 'm3u8 required' });
    const withRef = await fetchManifest(m3u8, referer || '');
    let hint = '';
    if (withRef.complete) hint = 'Manifest is complete with this referer.';
    else if (withRef.status === 0) hint = `Could not reach the stream host: ${withRef.error || 'network error'}.`;
    else if (withRef.text.trim().startsWith('#EXTM3U')) hint = 'Got a truncated manifest. This host wants a different Referer, usually the embed site the player came from.';
    else if (withRef.status === 403) hint = 'The host refused the request (403). Wrong Referer, or the stream has moved.';
    else if (withRef.status === 404) hint = 'The stream host has nothing at this slot right now (404). Usually the game is not live yet; it tends to appear a few minutes before kickoff. If the game is on, Convert the match page again for a fresh slot.';
    else hint = `Unexpected reply (${withRef.status}). The body did not look like an HLS manifest.`;
    return json(res, 200, { ok: withRef.complete, status: withRef.status, bytes: withRef.text.length, hint, head: withRef.text.slice(0, 600) });
  }

  if (req.method === 'POST' && p === '/api/stream') {
    const { m3u8, referer, title } = await readBody(req);
    if (!m3u8 || !/^https?:\/\//i.test(m3u8)) return json(res, 400, { error: 'Paste or convert a stream URL first.' });
    const cfg = loadConfig();
    const mpv = findMpv(cfg);
    if (!mpv.found) return json(res, 400, { error: 'mpv was not found. Install it (winget install mpv) or set the path to mpv.exe below.', code: 'NO_MPV' });
    const mpvArgs = buildMpvArgs(m3u8, referer);
    const command = buildCommandLine(mpv.path, m3u8, referer);
    try {
      const child = spawn(mpv.path, mpvArgs, { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', () => {});
      child.unref();
    } catch (e) {
      return json(res, 500, { error: `mpv failed to start: ${e.message}`, command });
    }
    remember(cfg, { pageUrl: (cfg.last && cfg.last.m3u8 === m3u8 ? cfg.last.pageUrl : '') || '', embedUrl: (cfg.last && cfg.last.m3u8 === m3u8 ? cfg.last.embedUrl : '') || '', m3u8, referer: referer || '', title: title || (cfg.last && cfg.last.m3u8 === m3u8 ? cfg.last.title : '') || '', at: new Date().toISOString() });
    saveConfig(cfg);
    console.log('[stream]', command);
    return json(res, 200, { ok: true, command });
  }

  if (req.method === 'POST' && p === '/api/command') {
    const { m3u8, referer } = await readBody(req);
    const mpv = findMpv(loadConfig());
    return json(res, 200, { command: buildCommandLine(mpv.path || 'mpv.exe', m3u8 || '<m3u8-url>', referer || '') });
  }

  if (req.method === 'POST' && p === '/api/mpv') {
    const { path: mpvPath } = await readBody(req);
    const cfg = loadConfig();
    const clean = String(mpvPath || '').trim().replace(/^"|"$/g, '');
    if (!clean) { delete cfg.mpvPath; saveConfig(cfg); return json(res, 200, { mpv: findMpv(cfg) }); }
    if (!fs.existsSync(clean)) return json(res, 400, { error: `Nothing at ${clean}. Point it at mpv.exe.` });
    cfg.mpvPath = clean; saveConfig(cfg);
    return json(res, 200, { mpv: findMpv(cfg) });
  }

  if (req.method === 'POST' && p === '/api/forget') {
    const { m3u8 } = await readBody(req);
    const cfg = loadConfig();
    cfg.history = (cfg.history || []).filter((h) => h.m3u8 !== m3u8);
    if (cfg.last && cfg.last.m3u8 === m3u8) cfg.last = cfg.history[0] || null;
    saveConfig(cfg);
    return json(res, 200, state());
  }

  if (req.method === 'POST' && p === '/api/quit') {
    json(res, 200, { ok: true });
    setTimeout(shutdown, 150);
    return;
  }

  if (req.method === 'GET') return serveStatic(req, res, p);
  res.writeHead(405); res.end();
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) json(res, 500, { error: e.message }); else res.end(); });
});

// ---------------------------------------------------------------------------
// UI window: Playwright's Chromium in --app mode looks like a native window.
// Falls back to the default browser if that binary is missing.

let uiProc = null;

function openUi(urlStr) {
  const found = findBrowser();
  if (found) {
    const profile = path.join(CONFIG_DIR, 'ui-profile');
    uiProc = spawn(found.exe, [
      `--app=${urlStr}`, `--user-data-dir=${profile}`, '--window-size=780,920', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate,MediaRouter', '--disable-extensions',
    ], { stdio: 'ignore', detached: false });
    const started = Date.now();
    uiProc.on('exit', () => {
      uiProc = null;
      // If the window went away straight after launch, Chromium handed off to
      // an existing profile instance; keep the server up in that case.
      if (Date.now() - started > 2500) shutdown();
    });
    uiProc.on('error', () => { uiProc = null; spawn('cmd', ['/c', 'start', '', urlStr], { stdio: 'ignore', detached: true }).unref(); });
    return;
  }
  spawn('cmd', ['/c', 'start', '', urlStr], { stdio: 'ignore', detached: true }).unref();
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('shutting down');
  if (uiProc) { try { uiProc.kill(); } catch {} }
  await closeBrowser();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function listen(port, attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 5) return listen(port + 1 + attempt, attempt + 1);
    console.error('could not bind a port:', e.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const urlStr = `http://127.0.0.1:${port}/`;
    console.log(`StreamGrabber on ${urlStr}`);
    console.log(`config: ${CONFIG_PATH}`);
    const mpv = findMpv(loadConfig());
    console.log(mpv.found ? `mpv: ${mpv.path}` : 'mpv: not found (set it in the UI)');
    const b = findBrowser();
    console.log(b ? `browser: ${b.name} (${b.exe})` : 'browser: none found, Convert will fail until Edge or Chrome is installed');
    // Warm the headless browser so the first Convert is quick.
    warm();
    if (!NO_OPEN) openUi(urlStr);
  });
}
listen(PORT);
