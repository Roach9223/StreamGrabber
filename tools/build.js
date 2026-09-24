'use strict';
// Builds dist/StreamGrabber.exe.
//
// pkg appends its payload to a base Node binary and records absolute file
// offsets, so editing the finished exe with rcedit breaks it. Instead a
// copy of pkg's base binary gets the icon and version info first, and pkg
// is pointed at that copy through PKG_NODE_PATH.
//   node tools/build.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { rcedit } = require('rcedit');

const ROOT = path.join(__dirname, '..');
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const out = path.join(ROOT, 'dist', 'StreamGrabber.exe');
const icon = path.join(ROOT, 'icon.ico');
const pkgCli = path.join(ROOT, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js');
const fetchVersion = require(path.join(ROOT, 'node_modules', '@yao-pkg', 'pkg-fetch', 'package.json')).version;
const cacheDir = process.env.PKG_CACHE_PATH || path.join(os.homedir(), '.pkg-cache', 'v' + fetchVersion.split('.').slice(0, 2).join('.'));
const stamped = path.join(ROOT, 'build', 'node-base-stamped.exe');

// No bytecode: pkg would strip the JS source, and then Function.prototype
// .toString() returns "[native code]". Playwright ships every page.evaluate
// callback to the browser as String(fn), so a bytecode build silently
// breaks script decoding, iframe scanning and player poking. Only streams
// that show up on the wire by themselves would still resolve.
const PKG_FLAGS = ['--no-bytecode', '--public', '--public-packages', '*'];
const runPkg = (env = {}) => execFileSync(process.execPath, [pkgCli, '.', '--output', out, '--compress', 'GZip', ...PKG_FLAGS], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
const findBase = () => (fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).find((f) => /^fetched-v\d+.*win-x64$/.test(f)) : null);

(async () => {
  if (!fs.existsSync(icon)) {
    console.log('no icon.ico yet, rendering one');
    execFileSync(process.execPath, [path.join(__dirname, 'make-icon.js')], { stdio: 'inherit' });
  }
  fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });

  // First run: let pkg download the base binary into its cache.
  let base = findBase();
  if (!base) {
    console.log('pkg: fetching the base Node binary');
    runPkg();
    base = findBase();
    if (!base) throw new Error('pkg did not leave a base binary in ' + cacheDir);
  }

  fs.mkdirSync(path.dirname(stamped), { recursive: true });
  fs.copyFileSync(path.join(cacheDir, base), stamped);
  console.log('rcedit: stamping icon + version onto a copy of', base);
  await rcedit(stamped, {
    icon,
    'file-version': pkgJson.version,
    'product-version': pkgJson.version,
    'version-string': {
      ProductName: 'StreamGrabber',
      FileDescription: 'StreamGrabber',
      CompanyName: 'Odin Official',
      LegalCopyright: `MIT, ${new Date().getFullYear()}`,
      OriginalFilename: 'StreamGrabber.exe',
    },
  });

  console.log('pkg: bundling on the stamped base');
  runPkg({ PKG_NODE_PATH: stamped });
  const mb = (fs.statSync(out).size / 1048576).toFixed(1);
  console.log(`done: ${out} (${mb} MB)`);
})().catch((e) => { console.error(e.message); process.exit(1); });
