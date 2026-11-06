// Small math and randomness helpers shared by every module.

export const TAU = Math.PI * 2;

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function smoothstep(a, b, v) { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

// Wrap an angle to [-PI, PI].
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

// Rotate `from` toward `to` by at most `step` radians.
export function approachAngle(from, to, step) {
  const d = wrapAngle(to - from);
  if (Math.abs(d) <= step) return to;
  return from + Math.sign(d) * step;
}

export function approach(v, target, step) {
  if (v < target) return Math.min(v + step, target);
  return Math.max(v - step, target);
}

// Forward vector for a yaw angle: yaw 0 faces +Z, positive yaw turns toward +X.
export function dirX(yaw) { return Math.sin(yaw); }
export function dirZ(yaw) { return Math.cos(yaw); }
export function yawOf(x, z) { return Math.atan2(x, z); }

export function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }

// Deterministic PRNG so a map can be regenerated from its seed.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randRange(rng, a, b) { return a + (b - a) * rng(); }
export function randInt(rng, a, b) { return Math.floor(a + (b - a + 1) * rng()); }
export function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

export function gaussian(rng = Math.random) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

// Closest distance (squared) from point P to segment AB, plus the segment parameter.
export function segPointDist2(ax, az, bx, bz, px, pz) {
  const abx = bx - ax, abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 0 ? ((px - ax) * abx + (pz - az) * abz) / len2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + abx * t, cz = az + abz * t;
  return { d2: dist2(cx, cz, px, pz), t };
}

export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};
