// Arena: random map generation, meshes, collision and shell tracing.
import * as THREE from '../vendor/three/build/three.module.js';
import { RoundedBoxGeometry } from '../vendor/three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from '../vendor/three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  CELL, GRID_W, GRID_H, EMPTY, BLOCK, LOW, CRATE, TRAP, HEIGHT, PERIMETER_HEIGHT,
} from './config.js';
import { mulberry32, randInt, clamp } from './utils.js';
import { assets } from './assets.js';

export const blocksShell = (t) => t === BLOCK || t === LOW || t === CRATE;
export const blocksTank = (t) => t !== EMPTY;
export const blocksSight = (t) => t === BLOCK || t === CRATE;

export class World {
  constructor(scene) {
    this.scene = scene;
    this.perimeter = [];
    this.group = new THREE.Group();
    scene.add(this.group);
    this.crateInstances = new Map(); // cell index -> [instance ids]
    this.seed = 1;
    this.materials = makeMaterials();
    this.geo = makeGeometries();
    this.buildGround();
    this.setSize(GRID_W, GRID_H);
  }

  // Arena dimensions in cells. Rebuilds the outer walls when the size changes.
  setSize(w, h) {
    if (this.W === w && this.H === h) return;
    this.W = w; this.H = h;
    this.HW = (w * CELL) / 2; this.HH = (h * CELL) / 2;
    this.grid = new Uint8Array(w * h);
    this.buildPerimeter();
  }

  // ---------- grid helpers ----------
  idx(cx, cz) { return cz * this.W + cx; }
  inside(cx, cz) { return cx >= 0 && cz >= 0 && cx < this.W && cz < this.H; }
  cell(cx, cz) { return this.inside(cx, cz) ? this.grid[cz * this.W + cx] : BLOCK; }
  toCellX(x) { return Math.floor((x + this.HW) / CELL); }
  toCellZ(z) { return Math.floor((z + this.HH) / CELL); }
  centerX(cx) { return -this.HW + (cx + 0.5) * CELL; }
  centerZ(cz) { return -this.HH + (cz + 0.5) * CELL; }
  walkable(cx, cz) { return this.inside(cx, cz) && this.grid[cz * this.W + cx] === EMPTY; }
  cellAtWorld(x, z) { return this.cell(this.toCellX(x), this.toCellZ(z)); }

  // ---------- generation ----------
  generate(seed) {
    this.seed = seed;
    const rng = mulberry32(seed);
    let result = null;
    for (let attempt = 0; attempt < 80 && !result; attempt++) {
      result = this.tryGenerate(rng, attempt, false);
    }
    if (!result) result = this.fallbackMap();
    return result;
  }

  // Multiplayer: always 8 spawn points (corners + edge midpoints), always symmetric.
  // Deterministic for a seed, so every client builds the same arena.
  generateMulti(seed) {
    const { W, H } = this;
    this.seed = seed;
    const rng = mulberry32(seed);
    let result = null;
    for (let attempt = 0; attempt < 120 && !result; attempt++) result = this.tryGenerate(rng, attempt, true);
    if (!result) { this.grid = new Uint8Array(W * H); result = this.multiSpawns(); }
    return result;
  }

  spawnCells() {
    const { W, H } = this;
    const mx = Math.floor(W / 2), mz = Math.floor(H / 2);
    // pairs are point-symmetric: (0,1) corners, (2,3) corners, (4,5) top/bottom, (6,7) left/right
    return [[1, 1], [W - 2, H - 2], [W - 2, 1], [1, H - 2], [mx - 1, 1], [W - mx, H - 2], [1, mz], [W - 2, H - 1 - mz]];
  }

  multiSpawns() {
    return this.spawnCells().map(([cx, cz]) => {
      const x = this.centerX(cx), z = this.centerZ(cz);
      return { x, z, yaw: Math.atan2(-x, -z) };
    });
  }

  // Open cells where a tank can spawn: the cell and all 8 neighbours are drivable.
  spawnCandidates() {
    const out = [];
    for (let cz = 1; cz < this.H - 1; cz++) for (let cx = 1; cx < this.W - 1; cx++) {
      let open = true;
      for (let dz = -1; dz <= 1 && open; dz++) for (let dx = -1; dx <= 1; dx++) if (!this.walkable(cx + dx, cz + dz)) { open = false; break; }
      if (open) out.push({ x: this.centerX(cx), z: this.centerZ(cz) });
    }
    return out;
  }

  // Spawn points for a multiplayer round: as far apart as possible, and never in plain
  // sight of a rival if the map allows it. `teams[i]` is spawn i's team (null for free-for-all).
  pickSpawns(count, seed, teams = null) {
    const rng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
    const cand = this.spawnCandidates();
    if (!cand.length) return this.multiSpawns().slice(0, count);
    const chosen = [];
    const side = (c, t) => (t === 0 ? c.x < -this.HW * 0.25 : c.x > this.HW * 0.25);
    for (let i = 0; i < count; i++) {
      const team = teams ? teams[i] : null;
      let pool = team == null ? cand : cand.filter((c) => side(c, team));
      if (!pool.length) pool = cand;
      if (!chosen.length) { // first spawn: somewhere out toward the edge of the arena
        const far = pool.slice().sort((a, b) => (b.x ** 2 + b.z ** 2) - (a.x ** 2 + a.z ** 2));
        chosen.push({ ...far[Math.floor(rng() * Math.max(1, Math.floor(far.length * 0.3)))], team });
        continue;
      }
      chosen.push({ ...this.bestSpot(pool, chosen.filter((c) => team == null || c.team !== team), chosen, rng), team });
    }
    return chosen.map((c) => ({ x: c.x, z: c.z, yaw: Math.atan2(-c.x, -c.z) }));
  }

  // Where to respawn: far from living enemies and out of their sight.
  pickRespawn(enemies, others) {
    const cand = this.spawnCandidates();
    if (!cand.length) return this.multiSpawns()[0];
    const c = this.bestSpot(cand, enemies, others, Math.random);
    return { x: c.x, z: c.z, yaw: Math.atan2(-c.x, -c.z) };
  }

  // Score = distance to the nearest rival, minus a heavy penalty per rival with a clear view.
  // Candidates are checked nearest-score-first so most line-of-sight tests are skipped.
  bestSpot(pool, rivals, everyone, rng) {
    const scored = [];
    for (const c of pool) {
      let near = Infinity, crowd = Infinity;
      for (const r of rivals) near = Math.min(near, Math.hypot(r.x - c.x, r.z - c.z));
      for (const o of everyone) crowd = Math.min(crowd, Math.hypot(o.x - c.x, o.z - c.z));
      if (crowd < 6) continue; // never on top of anyone
      if (!rivals.length) near = Math.min(crowd, 14);
      scored.push({ c, base: near + rng() * 0.6 });
    }
    if (!scored.length) return pool[Math.floor(rng() * pool.length)];
    scored.sort((a, b) => b.base - a.base);
    let best = null, bestScore = -Infinity;
    for (const s of scored) {
      if (s.base <= bestScore) break;
      let seen = 0;
      for (const r of rivals) if (this.lineClear(s.c.x, s.c.z, r.x, r.z, blocksSight)) seen++;
      const score = s.base - seen * 40;
      if (score > bestScore) { bestScore = score; best = s.c; }
    }
    return best || scored[0].c;
  }

  tryGenerate(rng, attempt, multi) {
    const { W, H } = this;
    const g = new Uint8Array(W * H);
    const symmetric = multi || rng() < 0.8;
    const set = (x, y, t) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      g[y * W + x] = t;
      if (symmetric) g[(H - 1 - y) * W + (W - 1 - x)] = t;
    };
    // obstacle count follows the arena area (tuned on the 20x14 medium arena)
    const scale = (W * H) / 280;
    const features = Math.max(3, Math.round((symmetric ? randInt(rng, 7, 10) : randInt(rng, 12, 18)) * scale));
    for (let i = 0; i < features; i++) {
      const r = rng();
      const x = randInt(rng, 1, W - 2), y = randInt(rng, 0, H - 1);
      if (r < 0.32) { // straight wall, sometimes capped with crates
        const horiz = rng() < 0.5, len = randInt(rng, 2, 5), type = rng() < 0.6 ? BLOCK : LOW;
        for (let k = 0; k < len; k++) set(x + (horiz ? k : 0), y + (horiz ? 0 : k), type);
        if (rng() < 0.3) set(x + (horiz ? len : 0), y + (horiz ? 0 : len), CRATE);
      } else if (r < 0.46) { // L-shaped wall
        const a = randInt(rng, 2, 4), b = randInt(rng, 2, 3), type = rng() < 0.7 ? BLOCK : LOW;
        const sx = rng() < 0.5 ? 1 : -1, sy = rng() < 0.5 ? 1 : -1;
        for (let k = 0; k < a; k++) set(x + k * sx, y, type);
        for (let k = 1; k < b; k++) set(x, y + k * sy, type);
      } else if (r < 0.58) { // pillar or 2x2 bunker
        const big = rng() < 0.4;
        set(x, y, BLOCK);
        if (big) { set(x + 1, y, BLOCK); set(x, y + 1, BLOCK); set(x + 1, y + 1, BLOCK); }
      } else if (r < 0.77) { // crate cluster
        let cx = x, cy = y;
        const n = randInt(rng, 1, 4);
        for (let k = 0; k < n; k++) {
          set(cx, cy, CRATE);
          if (rng() < 0.5) cx += rng() < 0.5 ? 1 : -1; else cy += rng() < 0.5 ? 1 : -1;
        }
      } else if (r < 0.89) { // tank traps
        const horiz = rng() < 0.5, len = randInt(rng, 1, 3);
        for (let k = 0; k < len; k++) set(x + (horiz ? k : 0), y + (horiz ? 0 : k), TRAP);
      } else { // low wall with a crate behind it
        const horiz = rng() < 0.5, len = randInt(rng, 2, 4);
        for (let k = 0; k < len; k++) set(x + (horiz ? k : 0), y + (horiz ? 0 : k), LOW);
        set(x + 1, y + 1, CRATE);
      }
    }

    const ps = { cx: 1, cz: randInt(rng, 1, H - 2) };
    const bs = symmetric ? { cx: W - 1 - ps.cx, cz: H - 1 - ps.cz } : { cx: W - 2, cz: randInt(rng, 1, H - 2) };
    const spawnCells = multi ? this.spawnCells().map(([cx, cz]) => ({ cx, cz })) : [ps, bs];
    if (multi) {
      for (const s of spawnCells) {
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const x = s.cx + dx, y = s.cz + dz;
          if (x >= 0 && y >= 0 && x < W && y < H) g[y * W + x] = EMPTY;
        }
      }
    } else {
      for (const s of [ps, bs]) {
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 2; dx++) {
          const x = s.cx + dx * (s === ps ? 1 : -1), y = s.cz + dz;
          if (x >= 0 && y >= 0 && x < W && y < H) g[y * W + x] = EMPTY;
        }
      }
    }

    // density check
    let filled = 0;
    for (let i = 0; i < g.length; i++) if (g[i] !== EMPTY) filled++;
    const ratio = filled / g.length;
    // eight cleared spawn pads take a big bite out of a small multiplayer arena
    const minRatio = multi && W * H < 200 ? 0.07 : 0.12;
    if (ratio < minRatio || ratio > 0.32) return null;

    // reachability check
    this.grid = g;
    const reach = this.flood(spawnCells[0].cx, spawnCells[0].cz);
    for (const s of spawnCells) if (!reach[s.cz * W + s.cx]) return null;
    let empty = 0, reached = 0;
    for (let i = 0; i < g.length; i++) if (g[i] === EMPTY) { empty++; if (reach[i]) reached++; }
    if (reached < empty * 0.86) return null;
    // fill unreachable pockets with crates so they become loot for mines
    for (let i = 0; i < g.length; i++) if (g[i] === EMPTY && !reach[i]) g[i] = CRATE;

    if (multi) return this.multiSpawns();

    // prefer maps where the spawns cannot shoot each other straight away
    const sx = this.centerX(ps.cx), sz = this.centerZ(ps.cz), ex = this.centerX(bs.cx), ez = this.centerZ(bs.cz);
    if (attempt < 50 && this.lineClear(sx, sz, ex, ez, blocksShell, 0.3)) return null;

    return this.spawnResult(ps, bs);
  }

  fallbackMap() {
    const { W, H } = this;
    const g = new Uint8Array(W * H);
    for (let y = 3; y < H - 3; y++) { g[y * W + 6] = BLOCK; g[y * W + (W - 7)] = BLOCK; }
    for (let x = 8; x < W - 8; x++) { g[3 * W + x] = CRATE; g[(H - 4) * W + x] = CRATE; }
    this.grid = g;
    return this.spawnResult({ cx: 1, cz: Math.floor(H / 2) }, { cx: W - 2, cz: Math.floor(H / 2) - 1 });
  }

  spawnResult(ps, bs) {
    const p = { x: this.centerX(ps.cx), z: this.centerZ(ps.cz) };
    const b = { x: this.centerX(bs.cx), z: this.centerZ(bs.cz) };
    return { player: { ...p, yaw: Math.PI / 2 }, bot: { ...b, yaw: -Math.PI / 2 } };
  }

  // 8-way flood fill over tank-walkable cells (no corner cutting)
  flood(sx, sz) {
    const { W, H } = this;
    const seen = new Uint8Array(W * H);
    const q = [sx, sz];
    seen[sz * W + sx] = 1;
    while (q.length) {
      const z = q.pop(), x = q.pop();
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = x + dx, nz = z + dz;
        if (!this.walkable(nx, nz) || seen[nz * W + nx]) continue;
        if (dx && dz && (!this.walkable(x + dx, z) || !this.walkable(x, z + dz))) continue;
        seen[nz * W + nx] = 1;
        q.push(nx, nz);
      }
    }
    return seen;
  }

  // ---------- collision ----------
  // Is a square of half-size r centred at (x, z) overlapping something that stops shells?
  shellBlockedAt(x, z, r) {
    const { HW, HH } = this;
    if (x - r < -HW || x + r > HW || z - r < -HH || z + r > HH) return true;
    const cx0 = Math.floor((x - r + HW) / CELL), cx1 = Math.floor((x + r + HW) / CELL);
    const cz0 = Math.floor((z - r + HH) / CELL), cz1 = Math.floor((z + r + HH) / CELL);
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
      if (blocksShell(this.cell(cx, cz))) return true;
    }
    return false;
  }

  // Push a circle out of walls. Mutates pos {x, z}. Returns true if it touched something.
  collideCircle(pos, r) {
    const { W, HW, HH } = this;
    let hit = false;
    for (let pass = 0; pass < 2; pass++) {
      const cx = this.toCellX(pos.x), cz = this.toCellZ(pos.z);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, nz = cz + dz;
        if (!this.inside(nx, nz) || !blocksTank(this.grid[nz * W + nx])) continue;
        const x0 = -HW + nx * CELL, z0 = -HH + nz * CELL;
        const px = clamp(pos.x, x0, x0 + CELL), pz = clamp(pos.z, z0, z0 + CELL);
        const ddx = pos.x - px, ddz = pos.z - pz;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 < r * r) {
          hit = true;
          if (d2 > 1e-8) {
            const d = Math.sqrt(d2), push = r - d;
            pos.x += (ddx / d) * push; pos.z += (ddz / d) * push;
          } else { // centre inside a block: shove toward the cell's nearest edge
            const ex = pos.x - (x0 + CELL / 2), ez = pos.z - (z0 + CELL / 2);
            if (Math.abs(ex) > Math.abs(ez)) pos.x = ex > 0 ? x0 + CELL + r : x0 - r;
            else pos.z = ez > 0 ? z0 + CELL + r : z0 - r;
          }
        }
      }
      const minX = -HW + r, maxX = HW - r, minZ = -HH + r, maxZ = HH - r;
      if (pos.x < minX) { pos.x = minX; hit = true; }
      if (pos.x > maxX) { pos.x = maxX; hit = true; }
      if (pos.z < minZ) { pos.z = minZ; hit = true; }
      if (pos.z > maxZ) { pos.z = maxZ; hit = true; }
    }
    return hit;
  }

  // Advance a shell-like state {x, z, dx, dz, bounces, r} by `dist`.
  // Calls onBounce(x, z, nx, nz) per ricochet. Returns false when the shell dies on a wall.
  advanceShell(s, dist, step = 0.08, onBounce = null) {
    let remaining = dist;
    while (remaining > 1e-6) {
      const d = Math.min(step, remaining);
      remaining -= d;
      let nx = s.x + s.dx * d;
      const hitX = this.shellBlockedAt(nx, s.z, s.r);
      if (hitX) nx = s.x;
      let nz = s.z + s.dz * d;
      const hitZ = this.shellBlockedAt(nx, nz, s.r);
      if (hitZ) nz = s.z;
      s.x = nx; s.z = nz;
      s.travel = (s.travel || 0) + d;
      if (hitX || hitZ) {
        if (s.bounces <= 0) { s.deadNormalX = hitX ? -Math.sign(s.dx) : 0; s.deadNormalZ = hitZ ? -Math.sign(s.dz) : 0; return false; }
        s.bounces--;
        if (hitX) s.dx = -s.dx;
        if (hitZ) s.dz = -s.dz;
        if (onBounce) onBounce(s.x, s.z, hitX ? Math.sign(s.dx) : 0, hitZ ? Math.sign(s.dz) : 0);
      }
    }
    return true;
  }

  // Predict a shell path as a polyline: [{x, z, d}] with cumulative distance d.
  tracePath(x, z, dx, dz, bounces, maxDist, r, step = 0.12) {
    const s = { x, z, dx, dz, bounces, r, travel: 0 };
    const pts = [{ x, z, d: 0 }];
    let alive = true;
    // stop a hair short of maxDist: float residue would otherwise never be consumed
    while (alive && maxDist - s.travel > 1e-4) {
      alive = this.advanceShell(s, Math.min(1.0, maxDist - s.travel), step, (bx, bz) => pts.push({ x: bx, z: bz, d: s.travel, bounce: true }));
    }
    pts.push({ x: s.x, z: s.z, d: s.travel, end: alive ? 'range' : 'wall' });
    return pts;
  }

  // Sample a straight line for obstacles. `test` picks which cell types block it.
  lineClear(ax, az, bx, bz, test = blocksSight, margin = 0) {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.ceil(len / 0.25);
    for (let i = 1; i < n; i++) {
      const t = i / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      if (margin > 0) {
        if (test === blocksShell ? this.shellBlockedAt(x, z, margin) : test(this.cellAtWorld(x, z))) return false;
      } else if (test(this.cellAtWorld(x, z))) return false;
    }
    return true;
  }

  // ---------- meshes ----------
  buildGround() {
    const m = this.materials;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), m.ground);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  buildPerimeter() {
    const { HW, HH } = this, m = this.materials;
    const ARENA_W = HW * 2, ARENA_H = HH * 2;
    for (const o of this.perimeter) { this.scene.remove(o); o.geometry.dispose(); }
    this.perimeter = [];
    const add = (o) => { this.scene.add(o); this.perimeter.push(o); };
    // perimeter walls
    const t = 1.2, h = PERIMETER_HEIGHT;
    const walls = [
      [ARENA_W + t * 2, h, t, 0, -HH - t / 2], [ARENA_W + t * 2, h, t, 0, HH + t / 2],
      [t, h, ARENA_H, -HW - t / 2, 0], [t, h, ARENA_H, HW + t / 2, 0],
    ];
    for (const [w, hh, d, x, z] of walls) {
      const mesh = new THREE.Mesh(worldBox(w, hh, d, 2.4), m.perimeter);
      mesh.position.set(x, hh / 2, z);
      mesh.castShadow = mesh.receiveShadow = true;
      add(mesh);
      const cap = new THREE.Mesh(worldBox(w + 0.16, 0.14, d + 0.16, 2.4), m.cap);
      cap.position.set(x, hh + 0.07, z);
      cap.castShadow = true;
      add(cap);
    }
    // corner towers
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const tower = new THREE.Mesh(new RoundedBoxGeometry(2.4, 4.4, 2.4, 2, 0.08), m.block);
      tower.position.set(sx * (HW + t / 2), 2.2, sz * (HH + t / 2));
      tower.castShadow = tower.receiveShadow = true;
      add(tower);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.35, 0.5), m.lamp);
      lamp.position.set(sx * (HW + t / 2) - sx * 0.9, 4.1, sz * (HH + t / 2) - sz * 0.9);
      lamp.lookAt(0, 0, 0);
      add(lamp);
    }
  }

  build() {
    const { W, H } = this;
    this.group.clear();
    this.crateInstances.clear();
    const m = this.materials, geo = this.geo;
    const cells = { [BLOCK]: [], [LOW]: [], [CRATE]: [], [TRAP]: [] };
    for (let cz = 0; cz < H; cz++) for (let cx = 0; cx < W; cx++) {
      const t = this.grid[cz * W + cx];
      if (t !== EMPTY) cells[t].push([cx, cz]);
    }
    const rng = mulberry32(this.seed ^ 0x9e3779b9);
    const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(1, 1, 1);
    const col = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);

    const instanced = (geometry, material, list, place) => {
      if (!list.length) return null;
      const mesh = new THREE.InstancedMesh(geometry, material, list.length);
      mesh.castShadow = mesh.receiveShadow = true;
      list.forEach((item, i) => { place(item, i); mesh.setMatrixAt(i, mat); });
      return mesh;
    };

    const tall = instanced(geo.block, m.block, cells[BLOCK], ([cx, cz], i) => {
      q.setFromAxisAngle(up, Math.floor(rng() * 4) * Math.PI / 2);
      pos.set(this.centerX(cx), HEIGHT[BLOCK] / 2, this.centerZ(cz));
      mat.compose(pos, q, scl);
    });
    if (tall) {
      cells[BLOCK].forEach((_, i) => { const v = 0.82 + rng() * 0.22; tall.setColorAt(i, col.setRGB(v, v * 0.99, v * 0.97)); });
      this.group.add(tall);
    }
    const low = instanced(geo.low, m.low, cells[LOW], ([cx, cz]) => {
      q.setFromAxisAngle(up, Math.floor(rng() * 4) * Math.PI / 2);
      pos.set(this.centerX(cx), HEIGHT[LOW] / 2, this.centerZ(cz));
      mat.compose(pos, q, scl);
    });
    if (low) this.group.add(low);

    // crates: a 2x2 stack with a random top layer, or one big crate
    const crates = [];
    for (const [cx, cz] of cells[CRATE]) {
      const ids = [];
      const x = this.centerX(cx), z = this.centerZ(cz);
      if (rng() < 0.3) {
        crates.push({ x, z, y: 0.88, s: 1.76, rot: (rng() - 0.5) * 0.12 }); ids.push(crates.length - 1);
      } else {
        const slots = [[-0.47, -0.47], [0.47, -0.47], [-0.47, 0.47], [0.47, 0.47]];
        for (const [ox, oz] of slots) {
          crates.push({ x: x + ox + (rng() - 0.5) * 0.04, z: z + oz + (rng() - 0.5) * 0.04, y: 0.45, s: 0.9, rot: (rng() - 0.5) * 0.16 });
          ids.push(crates.length - 1);
        }
        const tops = randInt(rng, 1, 3);
        const order = slots.slice().sort(() => rng() - 0.5).slice(0, tops);
        for (const [ox, oz] of order) {
          crates.push({ x: x + ox * 0.96, z: z + oz * 0.96, y: 1.35, s: 0.88, rot: (rng() - 0.5) * 0.4 });
          ids.push(crates.length - 1);
        }
      }
      this.crateInstances.set(cz * W + cx, ids);
    }
    this.crateList = crates;
    this.crateMesh = instanced(geo.crate, [m.crate, m.crateFrame], crates, (c) => {
      q.setFromAxisAngle(up, c.rot);
      pos.set(c.x, c.y, c.z);
      scl.setScalar(c.s);
      mat.compose(pos, q, scl);
      scl.setScalar(1);
    });
    if (this.crateMesh) this.group.add(this.crateMesh);

    // tank traps on concrete pads
    const traps = [];
    for (const [cx, cz] of cells[TRAP]) {
      const x = this.centerX(cx), z = this.centerZ(cz);
      if (rng() < 0.55) traps.push({ x, z, s: 0.95, rot: rng() * Math.PI });
      else {
        traps.push({ x: x - 0.42, z: z - 0.42, s: 0.72, rot: rng() * Math.PI });
        traps.push({ x: x + 0.42, z: z + 0.42, s: 0.72, rot: rng() * Math.PI });
      }
    }
    const pads = instanced(geo.pad, m.pad, cells[TRAP], ([cx, cz]) => {
      q.identity(); pos.set(this.centerX(cx), 0.04, this.centerZ(cz)); mat.compose(pos, q, scl);
    });
    if (pads) { pads.castShadow = false; this.group.add(pads); }
    const hedgehogs = instanced(geo.hedgehog, m.trap, traps, (t) => {
      q.setFromAxisAngle(up, t.rot); pos.set(t.x, 0.08, t.z); scl.setScalar(t.s); mat.compose(pos, q, scl); scl.setScalar(1);
    });
    if (hedgehogs) this.group.add(hedgehogs);
  }

  // Mine blast: remove crate cells touched by the circle. Returns removed crate boxes for debris.
  blastCrates(x, z, radius) {
    const { W, HW, HH } = this;
    const removed = [];
    const cx0 = this.toCellX(x - radius), cx1 = this.toCellX(x + radius);
    const cz0 = this.toCellZ(z - radius), cz1 = this.toCellZ(z + radius);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
      if (this.cell(cx, cz) !== CRATE) continue;
      const x0 = -HW + cx * CELL, z0 = -HH + cz * CELL;
      const px = clamp(x, x0, x0 + CELL), pz = clamp(z, z0, z0 + CELL);
      if ((px - x) ** 2 + (pz - z) ** 2 > radius * radius) continue;
      this.grid[cz * W + cx] = EMPTY;
      for (const id of this.crateInstances.get(cz * W + cx) || []) {
        removed.push(this.crateList[id]);
        this.crateMesh.setMatrixAt(id, zero);
      }
      this.crateInstances.delete(cz * W + cx);
      this.crateMesh.instanceMatrix.needsUpdate = true;
    }
    if (removed.length) this.crateMesh.computeBoundingSphere();
    return removed;
  }
}

// ---------- materials & geometry ----------
function pbrMaterial(set, opts = {}) {
  const t = assets.tex[set];
  return new THREE.MeshStandardMaterial({
    map: t.map, normalMap: t.normalMap, roughnessMap: t.arm, aoMap: t.arm, metalnessMap: opts.metal ? t.arm : null,
    metalness: opts.metal ? 1 : 0, roughness: 1, aoMapIntensity: 0.9, color: opts.color ?? 0xffffff,
    normalScale: new THREE.Vector2(opts.normal ?? 1, opts.normal ?? 1),
  });
}

function makeMaterials() {
  const ground = pbrMaterial('gravelly_sand', { color: 0xe8ddd0, normal: 1.4 });
  for (const t of [ground.map, ground.normalMap, ground.roughnessMap]) t.repeat.set(55, 55);
  // break up visible tiling by blending in a second, larger sample of the same texture
  ground.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec4 c1 = texture2D( map, vMapUv );
        vec4 c2 = texture2D( map, vMapUv * 0.213 + vec2( 0.37, 0.11 ) );
        float macro = texture2D( map, vMapUv * 0.041 + vec2( 0.5 ) ).g;
        vec4 sampledDiffuseColor = mix( c1, c2, 0.45 ) * ( 0.72 + macro * 0.6 );
        diffuseColor *= sampledDiffuseColor;
      #endif`);
  };
  const block = pbrMaterial('concrete_slab_wall', { color: 0xd9d6cf });
  const low = pbrMaterial('concrete_block_wall', { color: 0xc9c0b2 });
  const perimeter = pbrMaterial('concrete_block_wall', { color: 0xa79d90 });
  const cap = new THREE.MeshStandardMaterial({ color: 0x6f6b64, roughness: 0.92 });
  const crate = pbrMaterial('green_rough_planks', { color: 0xe6eadb });
  const crateFrame = pbrMaterial('dark_wooden_planks', { color: 0xb59c80 });
  const trap = pbrMaterial('rusty_metal_02', { metal: true, color: 0x8d7e74 });
  const pad = pbrMaterial('concrete_slab_wall', { color: 0x9a948a });
  const lamp = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff1d0, emissiveIntensity: 2.2 });
  return { ground, block, low, perimeter, cap, crate, crateFrame, trap, pad, lamp };
}

// Box with UVs scaled to world size, so textures keep a constant density.
export function worldBox(w, h, d, tile) {
  const g = new THREE.BoxGeometry(w, h, d);
  remapWorldUV(g, tile);
  return g;
}

function remapWorldUV(g, tile) {
  const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ax >= ay && ax >= az) { u = p.getZ(i); v = p.getY(i); }
    else if (ay >= ax && ay >= az) { u = p.getX(i); v = p.getZ(i); }
    else { u = p.getX(i); v = p.getY(i); }
    uv.setXY(i, u / tile + 0.5, v / tile + 0.5);
  }
  uv.needsUpdate = true;
}

function makeGeometries() {
  const block = new RoundedBoxGeometry(CELL, HEIGHT[BLOCK], CELL, 2, 0.07);
  remapWorldUV(block, 2.2);
  const low = new RoundedBoxGeometry(CELL, HEIGHT[LOW], CELL, 2, 0.06);
  remapWorldUV(low, 2.0);

  // crate = planked core + 12 dark frame beams (two material groups)
  const core = new THREE.BoxGeometry(0.94, 0.94, 0.94);
  remapWorldUV(core, 1.0);
  const beams = [];
  const bt = 0.1, L = 1.0;
  for (const a of [-1, 1]) for (const b of [-1, 1]) {
    const o = 0.5 - bt / 2;
    beams.push(new THREE.BoxGeometry(L, bt, bt).translate(0, a * o, b * o));
    beams.push(new THREE.BoxGeometry(bt, L, bt).translate(a * o, 0, b * o));
    beams.push(new THREE.BoxGeometry(bt, bt, L).translate(a * o, b * o, 0));
  }
  // diagonal braces on the four sides
  for (let k = 0; k < 4; k++) {
    const br = new THREE.BoxGeometry(1.2, 0.08, 0.05);
    br.rotateZ(Math.PI / 4).translate(0, 0, 0.485).rotateY((k * Math.PI) / 2);
    beams.push(br);
  }
  const frame = mergeGeometries(beams.map((b) => { remapWorldUV(b, 0.8); return b; }));
  const crate = mergeGeometries([core, frame], true);

  // Czech hedgehog: three crossed steel beams standing on their tips
  const parts = [];
  for (let k = 0; k < 3; k++) {
    const beam = new THREE.BoxGeometry(0.11, 0.11, 1.6);
    const flange = new THREE.BoxGeometry(0.035, 0.2, 1.6).translate(0.07, 0, 0);
    const b = mergeGeometries([beam, flange]);
    if (k === 1) b.rotateY(Math.PI / 2);
    if (k === 2) b.rotateX(Math.PI / 2);
    parts.push(b);
  }
  const hedgehog = mergeGeometries(parts);
  // stand the cube diagonal upright so the beams rest on three tips
  hedgehog.rotateZ(Math.PI / 4).rotateX(-Math.atan(1 / Math.SQRT2));
  hedgehog.computeBoundingBox();
  hedgehog.translate(0, -hedgehog.boundingBox.min.y, 0);
  hedgehog.scale(0.9, 0.55, 0.9);
  remapWorldUV(hedgehog, 0.6);

  const pad = worldBox(CELL * 0.94, 0.08, CELL * 0.94, 2);
  return { block, low, crate, hedgehog, pad };
}
