'use strict';
// Renders YouTube thumbnails (1280x720) for the StreamGrabber video from the
// project's own assets: the marketing renders in docs/marketing, the app
// icon, and Space Grotesk from public/fonts. Three variants, plus a contact
// sheet is left to ffmpeg. Text is large on purpose: a thumbnail is read at
// 200px wide in a sidebar.
//   node tools/make-thumbnail.js

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { findBrowser, NO_BROWSER_MSG } = require('../browsers');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'marketing', 'thumbnails');
const data = (p, mime) => `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;

const font = data(path.join(ROOT, 'public', 'fonts', 'SpaceGrotesk-Bold.ttf'), 'font/ttf');
const mono = data(path.join(ROOT, 'public', 'fonts', 'DMMono-Medium.ttf'), 'font/ttf');
const icon = data(path.join(ROOT, 'docs', 'marketing', 'icon-glass-512.png'), 'image/png');
const heroSignal = data(path.join(ROOT, 'source-assets', 'marketing', 'hero-signal.jpg'), 'image/jpeg');
const cleanFeed = data(path.join(ROOT, 'source-assets', 'marketing', 'social-clean-feed.jpg'), 'image/jpeg');
const uiShot = data(path.join(ROOT, 'docs', 'screenshot.png'), 'image/png');

const BG = '#0b0d10', GO = '#3df58c', BONE = '#e9edf2', LIVE = '#ff4d4d';

const base = `
  @font-face { font-family: 'SG'; src: url('${font}') format('truetype'); font-weight: 700; }
  @font-face { font-family: 'DM'; src: url('${mono}') format('truetype'); font-weight: 500; }
  html, body { margin: 0; width: 1280px; height: 720px; background: ${BG}; overflow: hidden; font-family: 'SG', 'Segoe UI', sans-serif; color: ${BONE}; }
  .bg { position: absolute; inset: 0; background-size: cover; background-position: center; }
  .shade { position: absolute; inset: 0; }
  .icon { position: absolute; width: 150px; height: 150px; }
  .pill { position: absolute; font-family: 'DM', monospace; font-size: 30px; letter-spacing: .14em; text-transform: uppercase; padding: 12px 22px; border-radius: 999px; }
  h1 { margin: 0; font-weight: 700; line-height: .95; letter-spacing: -.02em; }
`;

const variants = {
  // A: the hero illustration (ad tangle on the left, clean green signal on
  // the right) with the line stacked over the calm side.
  'no-ads': `<style>${base}
    .bg { background-image: url('${heroSignal}'); }
    .shade { background: linear-gradient(90deg, rgba(11,13,16,.15) 0%, rgba(11,13,16,.55) 45%, rgba(11,13,16,.92) 100%); }
    h1 { position: absolute; right: 70px; top: 150px; text-align: right; font-size: 128px; }
    h1 span { display: block; }
    h1 .g { color: ${GO}; }
    .icon { right: 70px; bottom: 60px; }
    .pill { left: 60px; bottom: 70px; background: ${LIVE}; color: #fff; }
  </style>
  <div class="bg"></div><div class="shade"></div>
  <h1><span>NO ADS.</span><span class="g">NO POPUPS.</span></h1>
  <img class="icon" src="${icon}" alt="">
  <span class="pill">Free tool</span>`,

  // B: flat, all type. The price against the word free.
  'price': `<style>${base}
    .col { position: absolute; left: 70px; top: 90px; }
    .was { font-size: 150px; color: #94a0b1; text-decoration: line-through; text-decoration-color: ${LIVE}; text-decoration-thickness: 14px; }
    .free { font-size: 250px; color: ${GO}; margin-top: -10px; }
    .sub { font-family: 'DM', monospace; font-size: 34px; letter-spacing: .12em; text-transform: uppercase; color: ${BONE}; margin-top: 8px; }
    .shot { position: absolute; right: -40px; top: 90px; width: 520px; border-radius: 18px; border: 3px solid #34404e; box-shadow: 0 30px 60px -20px rgba(0,0,0,.8); transform: rotate(-4deg); }
    .icon { right: 60px; bottom: 50px; width: 120px; height: 120px; }
  </style>
  <img class="shot" src="${uiShot}" alt="">
  <div class="col">
    <div class="was">$500</div>
    <div class="free">FREE</div>
    <div class="sub">Sports streams, no ads</div>
  </div>
  <img class="icon" src="${icon}" alt="">`,

  // C: the player illustration with the line on the left.
  'the-game': `<style>${base}
    .bg { background-image: url('${cleanFeed}'); background-position: 80% center; }
    .shade { background: linear-gradient(90deg, rgba(11,13,16,.96) 0%, rgba(11,13,16,.85) 40%, rgba(11,13,16,.1) 75%); }
    h1 { position: absolute; left: 70px; top: 140px; font-size: 132px; }
    h1 span { display: block; }
    h1 .g { color: ${GO}; }
    .icon { left: 70px; bottom: 60px; width: 120px; height: 120px; }
    .pill { left: 215px; bottom: 82px; border: 3px solid ${GO}; color: ${GO}; }
  </style>
  <div class="bg"></div><div class="shade"></div>
  <h1><span>THE GAME.</span><span class="g">NOTHING</span><span class="g">ELSE.</span></h1>
  <img class="icon" src="${icon}" alt="">
  <span class="pill">Free, open source</span>`,
};

(async () => {
  const b = findBrowser();
  if (!b) throw new Error(NO_BROWSER_MSG);
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: b.exe });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  for (const [name, body] of Object.entries(variants)) {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(200);
    const file = path.join(OUT, `thumbnail-${name}.png`);
    await page.screenshot({ path: file, type: 'png' });
    console.log('wrote', path.relative(ROOT, file));
  }
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
