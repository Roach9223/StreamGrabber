'use strict';
// Renders the app mark at several sizes with the local Edge/Chrome and packs
// them into icon.ico (PNG-in-ICO, fine on Vista and later). Also writes
// icon.png at 256px for the README and the page favicon.
//   node tools/make-icon.js

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { findBrowser, NO_BROWSER_MSG } = require('../browsers');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const ROOT = path.join(__dirname, '..');

const svg = (px) => `<!doctype html><html><body style="margin:0;background:transparent">
<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4dff9c"/><stop offset="1" stop-color="#22d477"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="60" height="60" rx="14" fill="#0b0d10"/>
  <rect x="5" y="5" width="54" height="54" rx="12" fill="url(#g)"/>
  <path d="M25 18 L46 32 L25 46 Z" fill="#06110b"/>
</svg></body></html>`;

function packIco(pngs) {
  // ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes each) + image data
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += buf.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]);
}

(async () => {
  const b = findBrowser();
  if (!b) throw new Error(NO_BROWSER_MSG);
  const browser = await chromium.launch({ headless: true, executablePath: b.exe });
  const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
  const pngs = [];
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(svg(size));
    const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    pngs.push({ size, buf });
    if (size === 256) fs.writeFileSync(path.join(ROOT, 'icon.png'), buf);
  }
  await browser.close();
  fs.writeFileSync(path.join(ROOT, 'icon.ico'), packIco(pngs));
  console.log(`icon.ico (${SIZES.join(', ')}px) and icon.png written`);
})().catch((e) => { console.error(e.message); process.exit(1); });
