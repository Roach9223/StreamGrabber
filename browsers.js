'use strict';
// Finds a Chromium-based browser to drive. Every Windows 10/11 machine has
// Edge, so the exe never needs to download a browser. Order:
//   1. STREAMGRABBER_BROWSER env var pointing at an exe
//   2. Microsoft Edge
//   3. Google Chrome
//   4. Playwright's own Chromium, if a dev install left one in the cache
// Returns { exe, channel, name } or null.

const fs = require('node:fs');
const path = require('node:path');

const PF = process.env['ProgramFiles'] || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCAL = process.env.LOCALAPPDATA || '';

const CANDIDATES = [
  { name: 'Microsoft Edge', channel: 'msedge', paths: [
    path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ] },
  { name: 'Google Chrome', channel: 'chrome', paths: [
    path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ] },
  { name: 'Brave', channel: null, paths: [
    path.join(PF, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ] },
];

let cached;

function findBrowser() {
  if (cached !== undefined) return cached;
  const env = process.env.STREAMGRABBER_BROWSER;
  if (env && fs.existsSync(env)) return (cached = { exe: env, channel: null, name: path.basename(env) });
  for (const c of CANDIDATES) {
    for (const p of c.paths) if (p && fs.existsSync(p)) return (cached = { exe: p, channel: c.channel, name: c.name });
  }
  // Playwright's cached Chromium (dev machines only).
  try {
    const exe = require('playwright-core').chromium.executablePath();
    if (exe && fs.existsSync(exe)) return (cached = { exe, channel: null, name: 'Playwright Chromium' });
  } catch {}
  return (cached = null);
}

const NO_BROWSER_MSG = 'No Chromium-based browser found. StreamGrabber drives Microsoft Edge or Google Chrome to read the page; install one of them, or set STREAMGRABBER_BROWSER to the path of a Chromium exe.';

module.exports = { findBrowser, NO_BROWSER_MSG };
