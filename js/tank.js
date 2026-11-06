// A tank: model rig (hull + independent turret), driving, collision and recoil.
import * as THREE from '../vendor/three/build/three.module.js';
import { clone as cloneSkinned } from '../vendor/three/examples/jsm/utils/SkeletonUtils.js';
import { assets } from './assets.js';
import { TANK_LENGTH, TANK_RADIUS } from './config.js';
import { wrapAngle, approach, clamp } from './utils.js';

const _box = new THREE.Box3();
const _v = new THREE.Vector3();

export class Tank {
  constructor({ model, paint, params, isPlayer, label }) {
    this.params = params;
    this.isPlayer = isPlayer;
    this.label = label;
    this.root = new THREE.Group();
    this.holder = new THREE.Group();     // normalised model space: forward = +Z, ground at y = 0
    this.root.add(this.holder);
    this.model = cloneSkinned(assets.models[model].scene);
    this.holder.add(this.model);
    this.materials = [];
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
      o.material = o.material.clone();
      const m = o.material;
      m.metalness = 0.35; m.roughness = 0.5;
      m.userData.base = m.color.clone();
      m.userData.orig = m.color.clone();
      this.materials.push(m);
    });
    if (paint != null) this.repaint(paint);
    this.rig();

    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const clip of assets.models[model].animations) {
      const key = clip.name.includes('Forward') ? 'fwd' : clip.name.includes('Backwards') ? 'back'
        : clip.name.includes('Left') ? 'left' : clip.name.includes('Right') ? 'right' : null;
      if (!key) continue;
      const a = this.mixer.clipAction(clip);
      a.play(); a.setEffectiveWeight(0); a.timeScale = 0;
      this.actions[key] = a;
    }

    this.reset(0, 0, 0);
  }

  restorePaint() {
    for (const m of this.materials) { m.userData.base = m.userData.orig.clone(); if (this.alive) m.color.copy(m.userData.orig); }
  }

  repaint(hex) {
    const paint = new THREE.Color(hex);
    for (const m of this.materials) {
      const n = m.name;
      const k = n === 'Main' ? 1 : n === 'Main_Dark' ? 0.62 : n === 'Main_Light' ? 1.45 : n === 'Main_Details' ? 0.42 : null;
      if (k == null) continue;
      m.color.copy(paint).multiplyScalar(k);
      m.userData.base = m.color.clone();
    }
  }

  // Normalise scale/orientation and build a pivot so the turret and gun can turn.
  rig() {
    const model = this.model;
    const turret = model.getObjectByName('Tank_Turret');
    const gun = model.getObjectByName('Tank_Gun');
    const hullParts = [];
    model.traverse((o) => { if (o.isMesh && o !== turret && o !== gun) hullParts.push(o); });

    const boxOf = (objs) => {
      const b = new THREE.Box3();
      this.root.updateMatrixWorld(true);
      for (const o of objs) { if (o.isSkinnedMesh) o.boundingBox = null; b.union(_box.setFromObject(o)); }
      return b;
    };

    // Quaternius tanks point their guns down -X; confirm from the gun offset when it is clear.
    let yaw = -Math.PI / 2;
    const tb = boxOf([turret]), gb = boxOf([gun]);
    const tc = tb.getCenter(new THREE.Vector3()), gc = gb.getCenter(new THREE.Vector3());
    const off = new THREE.Vector2(gc.x - tc.x, gc.z - tc.z);
    if (off.length() > tb.getSize(_v).length() * 0.12) yaw = Math.atan2(off.x, off.y);
    model.rotation.y = -yaw;

    let hb = boxOf(hullParts);
    const size = hb.getSize(new THREE.Vector3());
    model.scale.multiplyScalar(TANK_LENGTH / size.z);
    hb = boxOf(hullParts);
    const c = hb.getCenter(new THREE.Vector3());
    model.position.x -= c.x; model.position.z -= c.z; model.position.y -= hb.min.y;

    hb = boxOf(hullParts);
    const turretBox = boxOf([turret]), gunBox = boxOf([gun]);
    const tCenter = turretBox.getCenter(new THREE.Vector3());
    this.pivot = new THREE.Group();
    this.pivot.position.set(tCenter.x, turretBox.min.y, tCenter.z);
    this.holder.add(this.pivot);
    this.root.updateMatrixWorld(true);
    this.pivot.attach(turret);
    this.pivot.attach(gun);
    this.gun = gun;
    this.gunRest = gun.position.clone();

    const gCenter = gunBox.getCenter(new THREE.Vector3());
    this.muzzleForward = gunBox.max.z - tCenter.z;                    // along the turret's facing
    this.muzzleHeight = gCenter.y;
    this.pivotOffset = new THREE.Vector2(tCenter.x, tCenter.z);       // turret centre in hull space
    this.turretTop = turretBox.max.y;
    this.height = Math.max(hb.max.y, turretBox.max.y);
    this.halfLength = (hb.max.z - hb.min.z) / 2;
    this.halfWidth = (hb.max.x - hb.min.x) / 2;
  }

  reset(x, z, yaw) {
    this.x = x; this.z = z;
    this.hullYaw = yaw;
    this.turretYaw = yaw;
    this.speed = 0; this.targetSpeed = 0; this.turnRate = 0;
    this.reversing = false;
    this.alive = true;
    this.cooldown = 0.5;
    this.activeShells = 0;
    this.activeMines = 0;
    this.recoil = 0;
    this.pitch = 0; this.pitchV = 0; this.roll = 0; this.rollV = 0;   // suspension (radians, nose up / left side up)
    this.trackDist = 0; this.dustTimer = 0;
    this.bumpCooldown = 0;
    this.pivot.rotation.set(0, 0, 0);
    this.pivot.position.y = this.pivot.userData.y0 ?? (this.pivot.userData.y0 = this.pivot.position.y);
    for (const m of this.materials) { m.color.copy(m.userData.base); m.roughness = 0.5; m.metalness = 0.35; }
    this.root.visible = true;
    this.sync();
  }

  // Arcade drive: head toward a world yaw; reverse when the target is behind.
  drive(dt, wantYaw, throttle) {
    if (wantYaw == null || throttle < 0.01) { this.targetSpeed = 0; this.turnRate = 0; return; }
    let diff = wrapAngle(wantYaw - this.hullYaw);
    const flip = this.reversing ? Math.PI * 0.4 : Math.PI * 0.62;
    this.reversing = Math.abs(diff) > flip;
    if (this.reversing) diff = wrapAngle(diff + Math.PI);
    const step = clamp(diff, -this.params.hullTurn * dt, this.params.hullTurn * dt);
    this.hullYaw = wrapAngle(this.hullYaw + step);
    this.turnRate = step / Math.max(dt, 1e-4);
    const align = Math.cos(diff);
    const k = align > 0.72 ? (align - 0.72) / 0.28 : 0;
    const top = this.reversing ? (this.params.reverseSpeed ?? this.params.speed * 0.85) : this.params.speed;
    this.targetSpeed = (this.reversing ? -1 : 1) * throttle * k * top;
  }

  // Classic drive: W/S throttle along the hull, A/D rotate the hull.
  driveClassic(dt, throttle, turn) {
    const step = turn * this.params.hullTurn * dt;
    this.hullYaw = wrapAngle(this.hullYaw + step);
    this.turnRate = step / Math.max(dt, 1e-4);
    const top = throttle >= 0 ? this.params.speed : (this.params.reverseSpeed ?? this.params.speed * 0.85);
    this.targetSpeed = throttle * top;
  }

  aimToward(dt, yaw, rate) {
    const d = wrapAngle(yaw - this.turretYaw);
    const step = rate * dt;
    this.turretYaw = wrapAngle(Math.abs(d) <= step ? yaw : this.turretYaw + Math.sign(d) * step);
  }

  integrate(dt, world, others, effects) {
    const accel = Math.abs(this.targetSpeed) > Math.abs(this.speed) ? 9 : 14;
    const prevSpeed = this.speed;
    this.speed = approach(this.speed, this.targetSpeed, accel * dt);
    this.suspension(dt, (this.speed - prevSpeed) / Math.max(dt, 1e-4));
    const fx = Math.sin(this.hullYaw), fz = Math.cos(this.hullYaw);
    const px = this.x, pz = this.z;
    const pos = { x: this.x + fx * this.speed * dt, z: this.z + fz * this.speed * dt };
    const hitWall = world.collideCircle(pos, TANK_RADIUS);
    for (const o of others) {
      if (o === this || !o.alive) continue;
      const dx = pos.x - o.x, dz = pos.z - o.z, d = Math.hypot(dx, dz), min = TANK_RADIUS * 2;
      if (d < min && d > 1e-4) { pos.x += (dx / d) * (min - d); pos.z += (dz / d) * (min - d); world.collideCircle(pos, TANK_RADIUS); }
    }
    this.x = pos.x; this.z = pos.z;
    const moved = Math.hypot(this.x - px, this.z - pz);
    this.vx = (this.x - px) / Math.max(dt, 1e-4);
    this.vz = (this.z - pz) / Math.max(dt, 1e-4);
    if (hitWall && Math.abs(this.speed) > 1.5 && moved < Math.abs(this.speed) * dt * 0.5) {
      this.bumped = this.bumpCooldown <= 0;
      this.bumpCooldown = 0.6;
      if (this.bumped) this.pitchV -= Math.sign(this.speed) * 0.9;   // nose dips into the wall
      this.speed *= 0.4;
    } else this.bumped = false;
    this.bumpCooldown -= dt;
    this.actualSpeed = moved / Math.max(dt, 1e-4);

    if (effects) this.surfaceFx(effects, moved, dt);
  }

  // Tread marks and dust; also used for network-driven tanks.
  surfaceFx(effects, moved, dt) {
    const fx = Math.sin(this.hullYaw), fz = Math.cos(this.hullYaw);
    this.trackDist += moved + Math.abs(this.turnRate) * dt * 0.35;
    if (this.trackDist > 0.34) {
      this.trackDist = 0;
      const rx = Math.cos(this.hullYaw), rz = -Math.sin(this.hullYaw), w = this.halfWidth * 0.78;
      effects.trackMark(this.x + rx * w - fx * 0.5, this.z + rz * w - fz * 0.5, this.hullYaw);
      effects.trackMark(this.x - rx * w - fx * 0.5, this.z - rz * w - fz * 0.5, this.hullYaw);
    }
    this.dustTimer -= dt;
    if (this.actualSpeed > 1.2 && this.dustTimer <= 0) {
      this.dustTimer = 0.07;
      const s = Math.random() < 0.5 ? 1 : -1, rx = Math.cos(this.hullYaw) * s, rz = -Math.sin(this.hullYaw) * s;
      const back = Math.sign(this.speed) || 1;
      effects.dust(this.x + rx * this.halfWidth - fx * this.halfLength * back, this.z + rz * this.halfWidth - fz * this.halfLength * back, -fx * back, -fz * back);
    }
  }

  // Network-driven tank: place it from an interpolated sample and keep the suspension alive.
  applyNet(dt, x, z, hullYaw, turretYaw, speed, turnRate, effects) {
    const moved = Math.hypot(x - this.x, z - this.z);
    const prevSpeed = this.speed, inv = 1 / Math.max(dt, 1e-4);
    this.vx = moved < 3 ? (x - this.x) * inv : 0;
    this.vz = moved < 3 ? (z - this.z) * inv : 0;
    this.x = x; this.z = z;
    this.hullYaw = hullYaw;
    this.turretYaw = turretYaw;
    this.speed = speed;
    this.turnRate = turnRate;
    this.actualSpeed = moved * inv;
    this.suspension(dt, (speed - prevSpeed) / Math.max(dt, 1e-4));
    if (effects && moved < 3) this.surfaceFx(effects, moved, dt);
  }

  // Damped springs: squat when accelerating, dive when braking, lean out of turns.
  suspension(dt, accel) {
    const wantPitch = clamp(accel * 0.0042, -0.04, 0.04);
    const wantRoll = clamp(this.turnRate * this.speed * 0.007, -0.035, 0.035);
    this.pitchV += ((wantPitch - this.pitch) * 55 - this.pitchV * 7.5) * dt;
    this.rollV += ((wantRoll - this.roll) * 45 - this.rollV * 7) * dt;
    this.pitch = clamp(this.pitch + this.pitchV * dt, -0.08, 0.08);
    this.roll = clamp(this.roll + this.rollV * dt, -0.06, 0.06);
  }

  // Turret centre and muzzle in world space (2D).
  turretCenter() {
    const c = Math.cos(this.hullYaw), s = Math.sin(this.hullYaw);
    return { x: this.x + this.pivotOffset.x * c + this.pivotOffset.y * s, z: this.z - this.pivotOffset.x * s + this.pivotOffset.y * c };
  }

  muzzle() {
    const t = this.turretCenter();
    return { x: t.x + Math.sin(this.turretYaw) * this.muzzleForward, z: t.z + Math.cos(this.turretYaw) * this.muzzleForward, cx: t.x, cz: t.z };
  }

  // Does a point (with radius r) touch the hull rectangle?
  hitTest(x, z, r) {
    const dx = x - this.x, dz = z - this.z;
    const c = Math.cos(this.hullYaw), s = Math.sin(this.hullYaw);
    const lx = dx * c - dz * s, lz = dx * s + dz * c;   // into hull space (forward = +Z)
    return Math.abs(lx) < this.halfWidth + r && Math.abs(lz) < this.halfLength + r;
  }

  kick() { this.recoil = 1; }

  update(dt) {
    this.cooldown -= dt;
    this.recoil = Math.max(0, this.recoil - dt * 5);
    const a = this.actions;
    let key = null, rate = 0;
    if (this.alive) {
      if (Math.abs(this.actualSpeed ?? 0) > 0.2) { key = this.speed >= 0 ? 'fwd' : 'back'; rate = Math.min(2, Math.abs(this.speed) / this.params.speed * 1.5); }
      else if (Math.abs(this.turnRate) > 0.25) { key = this.turnRate > 0 ? 'left' : 'right'; rate = 1.1; }
    }
    for (const k in a) {
      const on = k === key;
      a[k].setEffectiveWeight(on ? 1 : 0);
      a[k].timeScale = on ? rate : 0;
    }
    this.mixer.update(dt);
    this.sync();
  }

  sync() {
    this.root.position.set(this.x, 0, this.z);
    this.root.rotation.y = this.hullYaw;
    if (this.alive) this.pivot.rotation.y = wrapAngle(this.turretYaw - this.hullYaw);
    this.holder.rotation.x = -this.pitch - this.recoil * this.recoil * 0.05;
    this.holder.rotation.z = this.roll;
    // slide the barrel back along the turret's facing (pivot space +Z is forward)
    if (this.gun) {
      this.gun.position.copy(this.gunRest);
      this.gun.position.z -= this.recoil * this.recoil * 0.25;
    }
  }

  wreck() {
    this.alive = false;
    this.speed = this.targetSpeed = 0;
    for (const m of this.materials) {
      m.color.copy(m.userData.base).multiplyScalar(0.18).lerp(new THREE.Color(0x1a1612), 0.5);
      m.roughness = 0.95; m.metalness = 0.1;
    }
    // turret knocked askew
    this.pivot.rotation.set((Math.random() - 0.5) * 0.5, this.pivot.rotation.y + (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 0.4);
    this.pivot.position.y = this.pivot.userData.y0 + 0.06;
    for (const k in this.actions) { this.actions[k].timeScale = 0; }
  }
}
