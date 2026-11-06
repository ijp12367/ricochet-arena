// Particles, debris, decals, light flashes and camera shake.
import * as THREE from '../vendor/three/build/three.module.js';
import { assets } from './assets.js';

const VERT = /* glsl */`
attribute vec3 iPos; attribute float iSize; attribute float iRot; attribute vec4 iColor;
varying vec2 vUv; varying vec4 vColor;
void main() {
  vUv = uv; vColor = iColor;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float c = cos(iRot), s = sin(iRot);
  mv.xy += vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iSize;
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = /* glsl */`
uniform sampler2D map;
varying vec2 vUv; varying vec4 vColor;
void main() {
  vec4 t = texture2D(map, vUv);
  gl_FragColor = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
  if (gl_FragColor.a < 0.003) discard;
}`;

// CPU-simulated camera-facing quads drawn in one instanced call.
class ParticleSystem {
  constructor(scene, texture, max, additive) {
    this.max = max;
    this.count = 0;
    this.p = new Float32Array(max * 20); // see emit() for the layout
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    geo.setAttribute('uv', quad.attributes.uv);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.aRot = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.aPos); geo.setAttribute('iSize', this.aSize);
    geo.setAttribute('iRot', this.aRot); geo.setAttribute('iColor', this.aCol);
    geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: texture } }, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 3 : 2;
    scene.add(this.mesh);
    this.geo = geo;
  }

  // o: {x,y,z, vx,vy,vz, life, s0, s1, r, g, b, a0, a1, rot, spin, drag, grav}
  emit(o) {
    if (this.count >= this.max) return;
    const i = this.count++ * 20, p = this.p;
    p[i] = o.x; p[i + 1] = o.y; p[i + 2] = o.z;
    p[i + 3] = o.vx || 0; p[i + 4] = o.vy || 0; p[i + 5] = o.vz || 0;
    p[i + 6] = 0; p[i + 7] = o.life;
    p[i + 8] = o.s0; p[i + 9] = o.s1 ?? o.s0;
    p[i + 10] = o.r; p[i + 11] = o.g; p[i + 12] = o.b;
    p[i + 13] = o.a0; p[i + 14] = o.a1 ?? 0;
    p[i + 15] = o.rot ?? Math.random() * 6.283; p[i + 16] = o.spin ?? 0;
    p[i + 17] = o.drag ?? 0; p[i + 18] = o.grav ?? 0;
    p[i + 19] = o.fadeIn ?? 0;
  }

  update(dt) {
    const p = this.p;
    let n = 0;
    const pos = this.aPos.array, size = this.aSize.array, rot = this.aRot.array, col = this.aCol.array;
    for (let k = 0; k < this.count; k++) {
      const i = k * 20;
      const age = p[i + 6] + dt;
      if (age >= p[i + 7]) continue;
      const j = n * 20;
      if (j !== i) for (let c = 0; c < 20; c++) p[j + c] = p[i + c];
      p[j + 6] = age;
      const drag = Math.max(0, 1 - p[j + 17] * dt);
      p[j + 3] *= drag; p[j + 4] = p[j + 4] * drag - p[j + 18] * dt; p[j + 5] *= drag;
      p[j] += p[j + 3] * dt; p[j + 1] += p[j + 4] * dt; p[j + 2] += p[j + 5] * dt;
      if (p[j + 1] < 0.02 && p[j + 18] > 0) { p[j + 1] = 0.02; p[j + 4] *= -0.3; p[j + 3] *= 0.6; p[j + 5] *= 0.6; }
      p[j + 15] += p[j + 16] * dt;
      const t = age / p[j + 7];
      const fade = p[j + 19] > 0 ? Math.min(1, t / p[j + 19]) : 1;
      pos[n * 3] = p[j]; pos[n * 3 + 1] = p[j + 1]; pos[n * 3 + 2] = p[j + 2];
      size[n] = p[j + 8] + (p[j + 9] - p[j + 8]) * Math.sqrt(t);
      rot[n] = p[j + 15];
      col[n * 4] = p[j + 10]; col[n * 4 + 1] = p[j + 11]; col[n * 4 + 2] = p[j + 12];
      col[n * 4 + 3] = (p[j + 13] + (p[j + 14] - p[j + 13]) * t) * fade;
      n++;
    }
    this.count = n;
    this.geo.instanceCount = n;
    this.aPos.needsUpdate = this.aSize.needsUpdate = this.aRot.needsUpdate = this.aCol.needsUpdate = true;
  }

  clear() { this.count = 0; this.geo.instanceCount = 0; }
}

// Tumbling chunks with simple ground bounces.
class Debris {
  constructor(scene, geometry, material, max) {
    this.mesh = new THREE.InstancedMesh(geometry, material, max);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.items = [];
    this.max = max;
    scene.add(this.mesh);
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.e = new THREE.Euler();
    this.v = new THREE.Vector3(); this.s = new THREE.Vector3();
  }
  spawn(x, y, z, vx, vy, vz, size, life = 4) {
    if (this.items.length >= this.max) this.items.shift();
    this.items.push({ x, y, z, vx, vy, vz, size, life, age: 0, rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6,
      sx: (Math.random() - 0.5) * 14, sy: (Math.random() - 0.5) * 14, sz: (Math.random() - 0.5) * 14 });
  }
  update(dt) {
    let n = 0;
    this.items = this.items.filter((d) => (d.age += dt) < d.life);
    for (const d of this.items) {
      d.vy -= 18 * dt;
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      const floor = d.size * 0.5;
      if (d.y < floor) {
        d.y = floor; d.vy = Math.abs(d.vy) * 0.3; d.vx *= 0.55; d.vz *= 0.55;
        d.sx *= 0.6; d.sy *= 0.6; d.sz *= 0.6;
      }
      d.rx += d.sx * dt; d.ry += d.sy * dt; d.rz += d.sz * dt;
      const shrink = Math.min(1, (d.life - d.age) / 0.6);
      this.q.setFromEuler(this.e.set(d.rx, d.ry, d.rz));
      this.m.compose(this.v.set(d.x, d.y, d.z), this.q, this.s.setScalar(d.size * shrink));
      this.mesh.setMatrixAt(n++, this.m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  clear() { this.items.length = 0; this.mesh.count = 0; }
}

export class Effects {
  constructor(scene, materials) {
    this.scene = scene;
    this.smoke = new ParticleSystem(scene, assets.sprites.smoke, 2600, false);
    this.glow = new ParticleSystem(scene, assets.sprites.glow, 1400, true);
    this.wood = new Debris(scene, new THREE.BoxGeometry(1, 0.3, 0.55), materials.crateFrame, 160);
    this.metal = new Debris(scene, new THREE.BoxGeometry(1, 0.35, 0.6), new THREE.MeshStandardMaterial({ color: 0x4a463f, roughness: 0.7, metalness: 0.5 }), 90);

    // light pool: fixed size so shaders never recompile mid-game
    this.lights = [];
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffa040, 0, 14, 2);
      l.userData = { life: 0, max: 1, peak: 0 };
      scene.add(l);
      this.lights.push(l);
    }

    // scorch decals
    this.decals = [];
    const decalMat = new THREE.MeshBasicMaterial({ map: assets.sprites.scorch, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const decalGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    for (let i = 0; i < 28; i++) {
      const d = new THREE.Mesh(decalGeo, decalMat);
      d.visible = false; d.renderOrder = 1;
      scene.add(d);
      this.decals.push(d);
    }
    this.decalNext = 0;

    // tread marks
    this.trackMax = 900;
    const trackMat = new THREE.MeshBasicMaterial({ map: assets.sprites.track, transparent: true, opacity: 0.55, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, color: 0x6b5a48 });
    this.tracks = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.3, 0.34).rotateX(-Math.PI / 2), trackMat, this.trackMax);
    this.tracks.count = 0; this.tracks.frustumCulled = false; this.tracks.renderOrder = 1;
    scene.add(this.tracks);
    this.trackNext = 0;
    this.tmpM = new THREE.Matrix4(); this.tmpQ = new THREE.Quaternion(); this.tmpV = new THREE.Vector3(); this.tmpS = new THREE.Vector3(1, 1, 1);
    this.up = new THREE.Vector3(0, 1, 0);

    this.trauma = 0;
  }

  update(dt) {
    this.smoke.update(dt);
    this.glow.update(dt);
    this.wood.update(dt);
    this.metal.update(dt);
    for (const l of this.lights) {
      const u = l.userData;
      if (u.life <= 0) { l.intensity = 0; continue; }
      u.life -= dt;
      const t = Math.max(0, u.life / u.max);
      l.intensity = u.peak * t * t;
    }
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
  }

  clear() {
    this.smoke.clear(); this.glow.clear(); this.wood.clear(); this.metal.clear();
    for (const d of this.decals) d.visible = false;
    this.tracks.count = 0; this.trackNext = 0;
    for (const l of this.lights) { l.userData.life = 0; l.intensity = 0; }
  }

  flash(x, y, z, color, peak, life) {
    const l = this.lights.reduce((a, b) => (a.userData.life < b.userData.life ? a : b));
    l.position.set(x, y, z);
    l.color.setHex(color);
    l.userData.life = life; l.userData.max = life; l.userData.peak = peak;
  }

  shake(amount) { this.trauma = Math.min(1, this.trauma + amount); }

  scorch(x, z, size) {
    const d = this.decals[this.decalNext];
    this.decalNext = (this.decalNext + 1) % this.decals.length;
    d.position.set(x, 0.015 + this.decalNext * 0.0004, z);
    d.rotation.y = Math.random() * Math.PI * 2;
    d.scale.set(size, 1, size);
    d.visible = true;
  }

  trackMark(x, z, yaw) {
    this.tmpQ.setFromAxisAngle(this.up, yaw);
    this.tmpM.compose(this.tmpV.set(x, 0.012, z), this.tmpQ, this.tmpS);
    this.tracks.setMatrixAt(this.trackNext, this.tmpM);
    this.trackNext = (this.trackNext + 1) % this.trackMax;
    this.tracks.count = Math.max(this.tracks.count, this.trackNext === 0 ? this.trackMax : this.trackNext);
    this.tracks.instanceMatrix.needsUpdate = true;
  }

  // ---------- composite effects ----------
  muzzle(x, y, z, dx, dz) {
    this.glow.emit({ x, y, z, life: 0.09, s0: 1.4, s1: 2.2, r: 4, g: 2.6, b: 1.2, a0: 1, a1: 0 });
    for (let i = 0; i < 6; i++) {
      const sp = 3 + Math.random() * 5;
      this.glow.emit({ x, y, z, vx: dx * sp + (Math.random() - 0.5) * 1.5, vy: Math.random() * 0.8, vz: dz * sp + (Math.random() - 0.5) * 1.5,
        life: 0.12 + Math.random() * 0.08, s0: 0.45, s1: 0.15, r: 3, g: 1.6, b: 0.5, a0: 0.9, a1: 0, drag: 6 });
    }
    for (let i = 0; i < 9; i++) {
      const sp = 1 + Math.random() * 3.5, side = (Math.random() - 0.5) * 2.2;
      this.smoke.emit({ x, y, z, vx: dx * sp - dz * side, vy: 0.3 + Math.random() * 0.7, vz: dz * sp + dx * side,
        life: 0.9 + Math.random() * 0.8, s0: 0.3, s1: 1.5 + Math.random(), r: 0.75, g: 0.72, b: 0.68, a0: 0.42, a1: 0, drag: 2.6, spin: (Math.random() - 0.5) * 2 });
    }
    this.flash(x + dx * 0.4, y + 0.3, z + dz * 0.4, 0xffb060, 55, 0.11);
  }

  trail(x, y, z, fast) {
    this.smoke.emit({ x: x + (Math.random() - 0.5) * 0.05, y, z: z + (Math.random() - 0.5) * 0.05, vy: 0.25,
      life: fast ? 0.55 : 0.8, s0: 0.12, s1: fast ? 0.55 : 0.7, r: 0.85, g: 0.84, b: 0.82, a0: 0.3, a1: 0, drag: 1.5, spin: 1 });
  }

  sparks(x, y, z, nx, nz, count = 10) {
    for (let i = 0; i < count; i++) {
      const sp = 3 + Math.random() * 6;
      this.glow.emit({ x, y, z, vx: (nx + (Math.random() - 0.5) * 1.6) * sp, vy: 1 + Math.random() * 4, vz: (nz + (Math.random() - 0.5) * 1.6) * sp,
        life: 0.25 + Math.random() * 0.3, s0: 0.12, s1: 0.04, r: 4, g: 2.6, b: 1.1, a0: 1, a1: 0.2, grav: 14, drag: 1.5 });
    }
    this.glow.emit({ x, y, z, life: 0.08, s0: 0.6, s1: 1.1, r: 3, g: 2.4, b: 1.4, a0: 0.9, a1: 0 });
    this.smoke.emit({ x, y, z, vx: nx * 0.6, vy: 0.4, vz: nz * 0.6, life: 0.7, s0: 0.2, s1: 0.9, r: 0.7, g: 0.66, b: 0.6, a0: 0.35, a1: 0, drag: 2 });
  }

  pop(x, y, z) {
    this.glow.emit({ x, y, z, life: 0.12, s0: 0.5, s1: 1.4, r: 3.5, g: 2, b: 0.8, a0: 1, a1: 0 });
    for (let i = 0; i < 5; i++) {
      this.smoke.emit({ x, y, z, vx: (Math.random() - 0.5) * 2, vy: 0.4 + Math.random(), vz: (Math.random() - 0.5) * 2,
        life: 0.8 + Math.random() * 0.4, s0: 0.25, s1: 0.9, r: 0.6, g: 0.58, b: 0.55, a0: 0.4, a1: 0, drag: 2.5 });
    }
  }

  explosion(x, z, scale = 1, y = 0.5) {
    const s = scale;
    this.glow.emit({ x, y: y + 0.4, z, life: 0.16, s0: 1.8 * s, s1: 4.2 * s, r: 2.6, g: 1.7, b: 0.8, a0: 0.9, a1: 0 });
    for (let i = 0; i < 24 * s; i++) { // fireball
      const a = Math.random() * 6.283, u = Math.random(), sp = (2 + Math.random() * 4.5) * s;
      this.glow.emit({ x, y: y + Math.random() * 0.5, z, vx: Math.cos(a) * sp * (1 - u * 0.5), vy: (1 + Math.random() * 3.5) * s, vz: Math.sin(a) * sp * (1 - u * 0.5),
        life: 0.3 + Math.random() * 0.4, s0: (0.7 + Math.random() * 0.7) * s, s1: (1.5 + Math.random() * 1.2) * s,
        r: 2.2, g: 0.75 + Math.random() * 0.5, b: 0.18, a0: 0.7, a1: 0, drag: 3.5, grav: -1.5, spin: (Math.random() - 0.5) * 3 });
    }
    for (let i = 0; i < 26 * s; i++) { // smoke column
      const a = Math.random() * 6.283, sp = (1 + Math.random() * 3.5) * s;
      const shade = 0.12 + Math.random() * 0.16;
      this.smoke.emit({ x, y: y + Math.random() * 0.6, z, vx: Math.cos(a) * sp, vy: (1.2 + Math.random() * 2.5) * s, vz: Math.sin(a) * sp,
        life: 1.8 + Math.random() * 1.8, s0: 0.8 * s, s1: (3 + Math.random() * 2.5) * s, r: shade, g: shade * 0.95, b: shade * 0.9,
        a0: 0.75, a1: 0, drag: 1.8, grav: -0.25, spin: (Math.random() - 0.5) * 1.2, fadeIn: 0.08 });
    }
    for (let i = 0; i < 24 * s; i++) { // embers
      const a = Math.random() * 6.283, sp = (4 + Math.random() * 9) * s;
      this.glow.emit({ x, y: y + 0.3, z, vx: Math.cos(a) * sp, vy: 3 + Math.random() * 7, vz: Math.sin(a) * sp,
        life: 0.6 + Math.random() * 0.9, s0: 0.14, s1: 0.05, r: 4, g: 2, b: 0.6, a0: 1, a1: 0, grav: 12, drag: 0.8 });
    }
    // dust ring along the ground
    for (let i = 0; i < 18 * s; i++) {
      const a = (i / (18 * s)) * 6.283, sp = 6 * s;
      this.smoke.emit({ x, y: 0.2, z, vx: Math.cos(a) * sp, vy: 0.3, vz: Math.sin(a) * sp, life: 1.2, s0: 0.6 * s, s1: 2.2 * s,
        r: 0.62, g: 0.5, b: 0.38, a0: 0.45, a1: 0, drag: 3 });
    }
    this.scorch(x, z, 3.6 * s);
    this.flash(x, y + 1.2, z, 0xff9a40, 140 * s, 0.45);
  }

  dust(x, z, dirX, dirZ) {
    this.smoke.emit({ x: x + (Math.random() - 0.5) * 0.3, y: 0.15, z: z + (Math.random() - 0.5) * 0.3,
      vx: dirX * 0.5 + (Math.random() - 0.5) * 0.4, vy: 0.35 + Math.random() * 0.3, vz: dirZ * 0.5 + (Math.random() - 0.5) * 0.4,
      life: 1.1, s0: 0.25, s1: 1.1, r: 0.66, g: 0.54, b: 0.42, a0: 0.22, a1: 0, drag: 1.6 });
  }

  wreckSmoke(x, z) {
    const shade = 0.1 + Math.random() * 0.1;
    this.smoke.emit({ x: x + (Math.random() - 0.5) * 0.6, y: 0.9, z: z + (Math.random() - 0.5) * 0.6,
      vx: 0.3 + Math.random() * 0.3, vy: 1.4 + Math.random() * 0.8, vz: 0.15,
      life: 3 + Math.random(), s0: 0.5, s1: 2.6, r: shade, g: shade, b: shade, a0: 0.5, a1: 0, drag: 0.4, spin: 0.5, fadeIn: 0.15 });
    if (Math.random() < 0.5) {
      this.glow.emit({ x: x + (Math.random() - 0.5) * 0.5, y: 0.8, z: z + (Math.random() - 0.5) * 0.5, vy: 1.2,
        life: 0.5, s0: 0.5, s1: 0.2, r: 3, g: 1.2, b: 0.3, a0: 0.8, a1: 0, drag: 1 });
    }
  }

  crateBurst(c) {
    const n = c.s > 1.2 ? 9 : 5;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, sp = 2 + Math.random() * 5;
      this.wood.spawn(c.x, c.y, c.z, Math.cos(a) * sp, 3 + Math.random() * 5, Math.sin(a) * sp, 0.18 + Math.random() * 0.22 * c.s, 3 + Math.random() * 2);
    }
    this.smoke.emit({ x: c.x, y: c.y, z: c.z, vy: 0.6, life: 1.4, s0: 0.6, s1: 2, r: 0.55, g: 0.48, b: 0.36, a0: 0.5, a1: 0, drag: 2 });
  }

  tankBurst(x, z) {
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * 6.283, sp = 2 + Math.random() * 6;
      this.metal.spawn(x, 0.8, z, Math.cos(a) * sp, 4 + Math.random() * 6, Math.sin(a) * sp, 0.08 + Math.random() * 0.16, 4 + Math.random() * 2);
    }
  }
}
