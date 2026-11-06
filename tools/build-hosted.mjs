// Build the hosted (claude.ai) copy: three.js from jsDelivr, .glb/.hdr packed as base64 JSON, everything else copied.
// Usage: node tools/build-hosted.mjs <RicochetArena folder> <output folder> [artifact link, used for invite links]
// Publish with the `room` capability so multiplayer can connect.
import fs from 'node:fs';
import path from 'node:path';
const [src, out, shareUrl] = process.argv.slice(2);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'js'), { recursive: true });

const share = shareUrl ? ` window.RICOCHET_SHARE_URL = ${JSON.stringify(shareUrl)};` : '';
const head = `<script>window.RICOCHET_PACKED = true;${share}</script>\n`
  + '<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>\n';
let html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
// the artifact host handles versions itself: swap the website's release block for a plain entry point
html = html.replace(/<!-- release:start[\s\S]*?<!-- release:end -->/, '<script type="module" src="js/main.js"></script>');
if (!html.includes('<script type="module"')) throw new Error('module script tag not found');
// the artifact host wraps the page in its own document, so drop ours
html = html.replace(/^\s*<!doctype html>\s*<html[^>]*>\s*<head>\s*<meta charset="utf-8">\s*<meta name="viewport"[^>]*>\s*/i, '')
  .replace(/<\/head>\s*<body>\s*/i, '\n')
  .replace(/\s*<\/body>\s*<\/html>\s*$/i, '\n');
if (/<!doctype|<html|<\/?head>|<\/?body>/i.test(html)) throw new Error('document shell not fully removed');
html = html.replace('<script type="module"', head + '<script type="module"');
fs.writeFileSync(path.join(out, 'index.html'), html);

for (const f of fs.readdirSync(path.join(src, 'js'))) {
  let code = fs.readFileSync(path.join(src, 'js', f), 'utf8');
  code = code.replaceAll("'../vendor/three/build/three.module.js'", "'three'").replaceAll("'../vendor/three/examples/jsm/", "'three/addons/");
  if (code.includes('vendor/three')) throw new Error('unrewritten vendor import in ' + f);
  fs.writeFileSync(path.join(out, 'js', f), code);
}

const list = [];
const walk = (rel) => {
  for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
    const r = rel + '/' + e.name;
    if (e.isDirectory()) { walk(r); continue; }
    if (r.endsWith('.txt')) continue;
    fs.mkdirSync(path.join(out, rel), { recursive: true });
    if (r.endsWith('.glb') || r.endsWith('.hdr')) {
      const b64 = fs.readFileSync(path.join(src, r)).toString('base64');
      fs.writeFileSync(path.join(out, r + '.json'), JSON.stringify({ b64 }));
      list.push(r + '.json');
    } else {
      fs.copyFileSync(path.join(src, r), path.join(out, r));
      list.push(r);
    }
  }
};
walk('assets');
for (const f of fs.readdirSync(path.join(out, 'js'))) list.push('js/' + f);
fs.writeFileSync(path.join(out, '..', 'artifact_files.json'), JSON.stringify(list.map((p) => ({ path: p }))));
console.log('built', list.length, 'files');
