// Stamp a release version into index.html and version.json, so browsers never mix cached
// files from an older release (GitHub Pages lets browsers keep files for 10 minutes).
// Run before committing a release:  node tools/stamp-version.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const d = new Date();
const pad = (n) => String(n).padStart(2, '0');
const v = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

// every game module gets a versioned address, so a new release can't load stale scripts
const modules = fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js')).sort();
const map = { imports: Object.fromEntries(modules.map((f) => [`./js/${f}`, `./js/${f}?v=${v}`])) };

const block = [
  '<!-- release:start (written by tools/stamp-version.mjs) -->',
  `<script>window.RICOCHET_VERSION = '${v}';</script>`,
  `<script type="importmap">${JSON.stringify(map)}</script>`,
  '<script>',
  "  // A page older than the site's current release reloads itself at a new address,",
  '  // which skips the stale copy the browser cached.',
  '  (function () {',
  "    if (location.protocol === 'file:' || window.RICOCHET_PACKED) return;",
  "    fetch('version.json?t=' + Date.now(), { cache: 'no-store' })",
  '      .then(function (r) { return r.ok ? r.json() : null; })',
  '      .then(function (d) {',
  '        if (!d || !d.v || d.v === window.RICOCHET_VERSION) return;',
  '        var q = new URLSearchParams(location.search);',
  "        if (q.get('v') === d.v) return;",
  "        q.set('v', d.v);",
  "        location.replace(location.pathname + '?' + q.toString() + location.hash);",
  '      })',
  '      .catch(function () {});',
  '  })();',
  '</script>',
  `<script type="module">import './js/main.js';</script>`,
  '<!-- release:end -->',
].join('\n');

const file = path.join(root, 'index.html');
let html = fs.readFileSync(file, 'utf8');
const re = /<!-- release:start[\s\S]*?<!-- release:end -->/;
if (re.test(html)) html = html.replace(re, block);
else if (html.includes('<script type="module" src="js/main.js"></script>')) html = html.replace('<script type="module" src="js/main.js"></script>', block);
else throw new Error('could not find where to put the release block in index.html');
fs.writeFileSync(file, html);
fs.writeFileSync(path.join(root, 'version.json'), JSON.stringify({ v }) + '\n');
console.log(`stamped release ${v} for ${modules.length} modules`);
