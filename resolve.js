#!/usr/bin/env node
'use strict';
// CLI: node resolve.js <url>   -> prints the m3u8 + referer as JSON
const { resolve, closeBrowser } = require('./resolver');

const url = process.argv[2];
if (!url) { console.error('usage: node resolve.js <match-page-or-embed-url>'); process.exit(2); }

resolve(url, (m) => console.error('  ' + m))
  .then((r) => { console.log(JSON.stringify({ m3u8: r.m3u8, referer: r.referer, embedUrl: r.embedUrl, method: r.method, verified: r.verified, title: r.title, elapsedMs: r.elapsedMs }, null, 2)); })
  .catch((e) => { console.error('ERROR', e.code || '', e.message); process.exitCode = 1; })
  .finally(() => closeBrowser());
