// Loads every texture, model and environment map up front.
import * as THREE from '../vendor/three/build/three.module.js';
import { GLTFLoader } from '../vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader } from '../vendor/three/examples/jsm/loaders/RGBELoader.js';

export const assets = {
  tex: {},            // name -> { map, normalMap, arm }
  models: {},         // key -> gltf
  envMap: null,       // PMREM texture for lighting
  background: null,   // equirect sky
  sunDir: new THREE.Vector3(0.4, 0.75, 0.3).normalize(),
  sprites: {},        // procedural particle textures
};

const PBR_SETS = ['gravelly_sand', 'concrete_slab_wall', 'concrete_block_wall', 'green_rough_planks', 'dark_wooden_planks', 'rusty_metal_02'];
const MODELS = { olive: 'tank_olive.glb', desert: 'tank_desert.glb', scout: 'tank_scout.glb', heavy: 'tank_heavy.glb' };

export async function loadAssets(renderer, onProgress) {
  const manager = new THREE.LoadingManager();
  manager.onProgress = (_url, loaded, total) => onProgress(loaded / total);
  const texLoader = new THREE.TextureLoader(manager);
  const gltfLoader = new GLTFLoader(manager);
  const rgbeLoader = new RGBELoader(manager).setDataType(THREE.FloatType);
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const tex = (url, srgb) => new Promise((resolve, reject) => {
    texLoader.load(url, (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = aniso;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      resolve(t);
    }, undefined, () => reject(new Error('Could not load ' + url)));
  });

  const jobs = [];
  for (const name of PBR_SETS) {
    const p = 'assets/textures/' + name;
    jobs.push(Promise.all([tex(p + '_diff.jpg', true), tex(p + '_nor_gl.jpg'), tex(p + '_arm.jpg')])
      .then(([map, normalMap, arm]) => { assets.tex[name] = { map, normalMap, arm }; }));
  }
  // The hosted build can't serve .glb/.hdr files, so it ships them base64-packed in JSON.
  const packed = (url) => {
    manager.itemStart(url);
    return fetch(url + '.json').then((r) => r.json()).then(({ b64 }) => {
      const bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      manager.itemEnd(url);
      return bytes.buffer;
    }).catch(() => { throw new Error('Could not load ' + url); });
  };
  const PACKED = window.RICOCHET_PACKED === true;

  for (const [key, file] of Object.entries(MODELS)) {
    const url = 'assets/models/' + file;
    if (PACKED) {
      jobs.push(packed(url).then((buf) => new Promise((resolve, reject) => gltfLoader.parse(buf, '', resolve, reject)))
        .then((g) => { assets.models[key] = g; }));
    } else {
      jobs.push(new Promise((resolve, reject) => gltfLoader.load(url,
        (g) => { assets.models[key] = g; resolve(); }, undefined, () => reject(new Error('Could not load ' + file)))));
    }
  }
  jobs.push(tex('assets/env/sky_bg.jpg', true).then((t) => {
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
    assets.background = t;
  }));
  const useHdr = (hdr) => {
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    findSun(hdr);
    const pmrem = new THREE.PMREMGenerator(renderer);
    assets.envMap = pmrem.fromEquirectangular(hdr).texture;
    pmrem.dispose();
    hdr.dispose();
  };
  const hdrUrl = 'assets/env/sky_1k.hdr';
  if (PACKED) {
    jobs.push(packed(hdrUrl).then((buf) => {
      const d = rgbeLoader.parse(buf);
      const t = new THREE.DataTexture(d.data, d.width, d.height, THREE.RGBAFormat, d.type);
      t.colorSpace = THREE.LinearSRGBColorSpace;
      t.minFilter = t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      t.flipY = true;
      t.needsUpdate = true;
      useHdr(t);
    }));
  } else {
    jobs.push(new Promise((resolve, reject) => rgbeLoader.load(hdrUrl, (hdr) => { useHdr(hdr); resolve(); },
      undefined, () => reject(new Error('Could not load sky_1k.hdr')))));
  }

  makeSprites();
  await Promise.all(jobs);
}

// Find the brightest region of the HDR so the shadow-casting sun lines up with the sky.
function findSun(hdr) {
  const { data, width, height } = hdr.image;
  let best = -1, bi = 0;
  for (let i = 0, n = width * height; i < n; i++) {
    const o = i * 4;
    const l = data[o] * 0.2126 + data[o + 1] * 0.7152 + data[o + 2] * 0.0722;
    if (l > best) { best = l; bi = i; }
  }
  const col = bi % width, row = Math.floor(bi / width);
  const u = (col + 0.5) / width;
  let v = 1 - (row + 0.5) / height;
  if (v < 0.5) v = 1 - v; // sun must be above the horizon whichever way rows are stored
  const theta = (u - 0.5) * Math.PI * 2;
  const phi = (v - 0.5) * Math.PI;
  assets.sunDir.set(Math.cos(theta) * Math.cos(phi), Math.sin(phi), Math.sin(theta) * Math.cos(phi)).normalize();
}

// Soft particle sprites drawn on canvases, so no extra downloads are needed.
function makeSprites() {
  const make = (size, draw) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d'), size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  assets.sprites.smoke = make(128, (g, s) => {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 22; i++) {
      const r = s * (0.12 + rnd() * 0.18);
      const x = s / 2 + (rnd() - 0.5) * s * 0.42, y = s / 2 + (rnd() - 0.5) * s * 0.42;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      const a = 0.16 + rnd() * 0.14;
      grd.addColorStop(0, `rgba(255,255,255,${a})`);
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, s, s);
    }
    // fade the edge so square corners never show
    g.globalCompositeOperation = 'destination-in';
    const edge = g.createRadialGradient(s / 2, s / 2, s * 0.2, s / 2, s / 2, s / 2);
    edge.addColorStop(0, 'rgba(0,0,0,1)'); edge.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = edge; g.fillRect(0, 0, s, s);
  });
  assets.sprites.glow = make(64, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,255,255,0.75)');
    grd.addColorStop(0.6, 'rgba(255,255,255,0.18)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
  });
  assets.sprites.scorch = make(128, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(10,8,6,0.95)');
    grd.addColorStop(0.45, 'rgba(20,15,10,0.7)');
    grd.addColorStop(0.8, 'rgba(30,22,14,0.25)');
    grd.addColorStop(1, 'rgba(30,22,14,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    let seed = 3;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    g.strokeStyle = 'rgba(8,6,4,0.5)';
    for (let i = 0; i < 26; i++) { // radial streaks
      const a = rnd() * Math.PI * 2, r0 = s * 0.12, r1 = s * (0.3 + rnd() * 0.2);
      g.lineWidth = 1 + rnd() * 3;
      g.beginPath(); g.moveTo(s / 2 + Math.cos(a) * r0, s / 2 + Math.sin(a) * r0);
      g.lineTo(s / 2 + Math.cos(a) * r1, s / 2 + Math.sin(a) * r1); g.stroke();
    }
  });
  assets.sprites.track = make(32, (g, s) => {
    g.fillStyle = 'rgba(0,0,0,0)'; g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 8) { g.fillStyle = 'rgba(25,18,12,0.55)'; g.fillRect(2, y, s - 4, 5); }
  });
}
