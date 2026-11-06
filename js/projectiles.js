// Ricochet shells and proximity mines.
// In multiplayer only the host is `authoritative`: it decides hits, clashes and detonations.
// Clients still fly shells (wall bounces are deterministic) and wait for the host's word on the rest.
import * as THREE from '../vendor/three/build/three.module.js';
import { SHELL_Y, SHELL_RADIUS, MINE_RADIUS, MINE_FUSE, MINE_TRIGGER, MINE_BLAST, CRATE } from './config.js';

const SELF_GRACE = 1.3; // distance a fresh shell travels before it can hit its own tank

export class Projectiles {
  constructor(game) {
    this.game = game;
    this.shells = [];
    this.mines = [];
    this.authoritative = true;
    // multiplayer hooks
    this.onFire = null;       // (tank, shell) a local tank fired
    this.onMineLaid = null;   // (tank, mine) a local tank laid a mine
    this.onShellGone = null;  // (shell, why) authoritative clash/blast removal
    this.onDetonate = null;   // (mine) authoritative detonation
    const scene = game.scene;

    // shell meshes: brass body, dark tip and a hot tracer that the bloom pass picks up
    const body = new THREE.CylinderGeometry(0.075, 0.085, 0.34, 10).rotateX(Math.PI / 2);
    const tip = new THREE.ConeGeometry(0.075, 0.16, 10).rotateX(Math.PI / 2).translate(0, 0, 0.25);
    this.shellGeo = { body, tip, tracer: new THREE.SphereGeometry(0.1, 10, 8) };
    this.shellMat = {
      body: new THREE.MeshStandardMaterial({ color: 0xb08d57, metalness: 0.85, roughness: 0.32 }),
      tip: new THREE.MeshStandardMaterial({ color: 0x2c2a26, metalness: 0.6, roughness: 0.4 }),
      tracer: new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 2.4, 0.9) }),
      tracerEnemy: new THREE.MeshBasicMaterial({ color: new THREE.Color(5.5, 1.1, 0.6) }),
    };
    this.shellPool = [];
    this.scene = scene;

    // mine meshes
    this.mineGeo = {
      base: new THREE.CylinderGeometry(MINE_RADIUS, MINE_RADIUS * 1.08, 0.1, 20),
      dome: new THREE.SphereGeometry(MINE_RADIUS * 0.7, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      ring: new THREE.TorusGeometry(MINE_RADIUS * 0.86, 0.025, 6, 24).rotateX(Math.PI / 2),
      light: new THREE.SphereGeometry(0.06, 10, 8),
    };
    this.mineMat = {
      base: new THREE.MeshStandardMaterial({ color: 0x3b3d2e, metalness: 0.6, roughness: 0.45 }),
      dome: new THREE.MeshStandardMaterial({ color: 0x4a4c39, metalness: 0.5, roughness: 0.5 }),
      ring: new THREE.MeshStandardMaterial({ color: 0xd2a636, metalness: 0.3, roughness: 0.5 }),
    };
  }

  clear() {
    for (const s of this.shells) this.releaseShell(s);
    this.shells.length = 0;
    for (const m of this.mines) this.scene.remove(m.mesh);
    this.mines.length = 0;
    for (const t of this.game.tanks || []) { t.activeShells = 0; t.activeMines = 0; }
  }

  shellMesh(enemy) {
    let g = this.shellPool.pop();
    if (!g) {
      g = new THREE.Group();
      const b = new THREE.Mesh(this.shellGeo.body, this.shellMat.body);
      const t = new THREE.Mesh(this.shellGeo.tip, this.shellMat.tip);
      const tr = new THREE.Mesh(this.shellGeo.tracer, this.shellMat.tracer);
      tr.position.z = -0.2; tr.scale.set(1, 1, 1.8);
      b.castShadow = true;
      g.add(b, t, tr);
      g.userData.tracer = tr;
    }
    g.userData.tracer.material = enemy ? this.shellMat.tracerEnemy : this.shellMat.tracer;
    this.scene.add(g);
    return g;
  }

  releaseShell(s) {
    if (!s.mesh) return;
    this.scene.remove(s.mesh);
    this.shellPool.push(s.mesh);
    s.mesh = null;
  }

  canFire(tank) {
    return tank.alive && tank.cooldown <= 0 && tank.activeShells < tank.params.maxShells;
  }

  fire(tank) {
    if (!this.canFire(tank)) return null;
    const m = tank.muzzle();
    // origin and angle are rounded to what the network carries, so every client flies the same path
    const s = this.spawn(tank, Math.round(m.cx * 100) / 100, Math.round(m.cz * 100) / 100, Math.round(tank.turretYaw * 1000) / 1000);
    s.id = tank.shotSeq = (tank.shotSeq || 0) + 1;
    tank.cooldown = tank.params.cooldown;
    if (this.onFire) this.onFire(tank, s);
    return s;
  }

  // A shot announced over the network (or by the host for a bot).
  fireFrom(tank, ox, oz, yaw, id) {
    if (!tank) return null;
    const s = this.spawn(tank, ox, oz, yaw);
    s.id = id;
    return s;
  }

  spawn(tank, ox, oz, yaw) {
    const g = this.game, p = tank.params;
    const dx = Math.sin(yaw), dz = Math.cos(yaw);
    const s = { x: ox, z: oz, dx, dz, bounces: p.bounces, startBounces: p.bounces, r: SHELL_RADIUS, travel: 0,
      owner: tank, speed: p.shellSpeed, age: 0, alive: true, trailT: 0, fast: p.shellSpeed > 15, id: 0, ox, oz, yaw };
    tank.activeShells++;
    tank.kick();
    const mx = ox + dx * tank.muzzleForward, mz = oz + dz * tank.muzzleForward;
    const mine = tank === g.player && g.state !== 'menu';
    g.effects.muzzle(mx, SHELL_Y + 0.08, mz, dx, dz);
    g.audio.cannon(mx, SHELL_Y, mz, mine);
    if (mine) g.effects.shake(0.18);
    // travel from the turret centre out to the muzzle, so point-blank walls ricochet properly
    const alive = g.world.advanceShell(s, tank.muzzleForward, 0.05, (bx, bz, nx, nz) => this.onBounce(s, bx, bz, nx, nz));
    s.travel = 0;
    s.mesh = this.shellMesh(tank !== g.player);
    this.syncMesh(s);
    this.shells.push(s);
    if (!alive) this.kill(s, 'wall');
    return s;
  }

  layMine(tank) {
    if (!tank.alive || tank.activeMines >= (tank.params.maxMines ?? 0)) return null;
    const x = tank.x - Math.sin(tank.hullYaw) * 0.3, z = tank.z - Math.cos(tank.hullYaw) * 0.3;
    for (const m of this.mines) if ((m.x - x) ** 2 + (m.z - z) ** 2 < 1.4) return null;
    const mine = this.placeMine(tank, Math.round(x * 100) / 100, Math.round(z * 100) / 100);
    mine.id = tank.mineSeq = (tank.mineSeq || 0) + 1;
    if (this.onMineLaid) this.onMineLaid(tank, mine);
    return mine;
  }

  layMineAt(tank, x, z, id) {
    if (!tank) return null;
    const mine = this.placeMine(tank, x, z);
    mine.id = id;
    return mine;
  }

  placeMine(tank, x, z) {
    const mesh = new THREE.Group();
    const base = new THREE.Mesh(this.mineGeo.base, this.mineMat.base); base.position.y = 0.05;
    const dome = new THREE.Mesh(this.mineGeo.dome, this.mineMat.dome); dome.position.y = 0.1;
    const ring = new THREE.Mesh(this.mineGeo.ring, this.mineMat.ring); ring.position.y = 0.1;
    const lightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 0.02, 0.02) });
    const light = new THREE.Mesh(this.mineGeo.light, lightMat); light.position.y = 0.33;
    base.castShadow = dome.castShadow = true;
    mesh.add(base, dome, ring, light);
    mesh.position.set(x, 0, z);
    this.scene.add(mesh);
    const mine = { owner: tank, x, z, fuse: MINE_FUSE, triggered: false, triggerT: 0, mesh, lightMat, blinkT: 0, on: false, dead: false, id: 0 };
    this.mines.push(mine);
    tank.activeMines++;
    this.game.audio.play('mine_drop', { x, y: 0.2, z, volume: 0.8 });
    return mine;
  }

  onBounce(s, x, z, nx, nz) {
    const g = this.game;
    g.effects.sparks(x, SHELL_Y, z, nx, nz, 8);
    g.audio.play('ricochet', { x, y: SHELL_Y, z, volume: 0.8, rate: 0.9 + Math.random() * 0.25 });
  }

  kill(s, why) {
    if (!s.alive) return;
    s.alive = false;
    s.owner.activeShells = Math.max(0, s.owner.activeShells - 1);
    const g = this.game;
    if (why === 'wall') {
      const type = g.world.cellAtWorld(s.x + (s.deadNormalX ? -s.deadNormalX : 0) * 0.3, s.z + (s.deadNormalZ ? -s.deadNormalZ : 0) * 0.3);
      g.effects.pop(s.x, SHELL_Y, s.z);
      g.audio.play(type === CRATE ? 'hit_wood' : 'hit_stone', { x: s.x, y: SHELL_Y, z: s.z, volume: 0.9 });
    } else if (why === 'clash') {
      g.effects.pop(s.x, SHELL_Y, s.z);
      g.effects.sparks(s.x, SHELL_Y, s.z, 0, 0, 6);
      g.audio.play('shell_clash', { x: s.x, y: SHELL_Y, z: s.z, volume: 1 });
    } else if (why === 'blast' || why === 'remote') {
      g.effects.pop(s.x, SHELL_Y, s.z);
    }
    if (this.authoritative && (why === 'clash' || why === 'blast') && this.onShellGone) this.onShellGone(s, why);
  }

  // Host said this shell is gone (hit a tank, clashed, blown up).
  removeShell(owner, id, why = 'remote') {
    for (const s of this.shells) {
      if (s.alive && s.owner === owner && s.id === id) {
        if (why === 'silent') { s.alive = false; s.owner.activeShells = Math.max(0, s.owner.activeShells - 1); }
        else this.kill(s, why === 'clash' ? 'clash' : 'remote');
        return true;
      }
    }
    return false;
  }

  syncMesh(s) {
    s.mesh.position.set(s.x, SHELL_Y, s.z);
    s.mesh.rotation.y = Math.atan2(s.dx, s.dz);
  }

  update(dt) {
    const g = this.game;
    const tanks = g.tanks;
    const auth = this.authoritative;
    let maxStep = 0;
    for (const s of this.shells) maxStep = Math.max(maxStep, s.speed * dt);
    const subs = Math.max(1, Math.ceil(maxStep / 0.2));
    const h = dt / subs;

    for (let k = 0; k < subs; k++) {
      for (const s of this.shells) {
        if (!s.alive) continue;
        s.age += h;
        const ok = g.world.advanceShell(s, s.speed * h, 0.08, (bx, bz, nx, nz) => this.onBounce(s, bx, bz, nx, nz));
        if (!ok) { this.kill(s, 'wall'); continue; }
        if (!auth) continue;
        // tanks
        for (const t of tanks) {
          if (!t.alive) continue;
          if (t === s.owner && s.travel < SELF_GRACE && s.bounces === s.startBounces) continue;
          if (!g.canDamage(s.owner, t)) continue;
          if (t.hitTest(s.x, s.z, s.r)) {
            s.alive = false;
            s.owner.activeShells = Math.max(0, s.owner.activeShells - 1);
            g.tankHit(t, { kind: 'shell', by: s.owner, bounced: s.bounces < s.startBounces, shot: s });
            break;
          }
        }
        if (!s.alive) continue;
        // mines
        for (const m of this.mines) {
          if (m.dead) continue;
          if ((m.x - s.x) ** 2 + (m.z - s.z) ** 2 < (MINE_RADIUS + s.r) ** 2) {
            this.kill(s, 'blast');
            this.detonate(m);
            break;
          }
        }
      }
      if (!auth) continue;
      // shell vs shell
      for (let i = 0; i < this.shells.length; i++) {
        const a = this.shells[i];
        if (!a.alive) continue;
        for (let j = i + 1; j < this.shells.length; j++) {
          const b = this.shells[j];
          if (!b.alive) continue;
          const rr = a.r + b.r + 0.06;
          if ((a.x - b.x) ** 2 + (a.z - b.z) ** 2 < rr * rr) { this.kill(a, 'clash'); this.kill(b, 'clash'); break; }
        }
      }
    }

    // visuals, trails, cleanup
    for (const s of this.shells) {
      if (s.alive && s.age > 25) this.kill(s, 'blast');
      if (!s.alive) { this.releaseShell(s); continue; }
      this.syncMesh(s);
      s.trailT -= dt;
      if (s.trailT <= 0) { s.trailT = 0.028; g.effects.trail(s.x - s.dx * 0.3, SHELL_Y, s.z - s.dz * 0.3, s.fast); }
    }
    this.shells = this.shells.filter((s) => s.alive);

    // mines: clients only blink; the host owns fuses and proximity triggers
    for (const m of this.mines) {
      if (m.dead) continue;
      m.fuse -= dt;
      if (auth) {
        if (!m.triggered) {
          for (const t of tanks) {
            if (!t.alive || t === m.owner || !g.canDamage(m.owner, t)) continue;
            if ((t.x - m.x) ** 2 + (t.z - m.z) ** 2 < MINE_TRIGGER * MINE_TRIGGER) { m.triggered = true; m.triggerT = 0.4; }
          }
        } else m.triggerT -= dt;
        if (m.fuse <= 0 || (m.triggered && m.triggerT <= 0)) { this.detonate(m); continue; }
      }
      const period = m.triggered ? 0.07 : m.fuse > 4 ? 0.9 : m.fuse > 1.8 ? 0.4 : 0.13;
      m.blinkT -= dt;
      if (m.blinkT <= 0) {
        m.blinkT = period;
        m.on = !m.on;
        m.lightMat.color.setRGB(m.on ? 6 : 0.3, m.on ? 0.5 : 0.02, m.on ? 0.3 : 0.02);
        if (m.on && (m.fuse < 4 || m.triggered)) g.audio.play('mine_beep', { x: m.x, y: 0.3, z: m.z, volume: 0.5, rate: m.triggered ? 1.4 : 1 });
      }
    }
    this.mines = this.mines.filter((m) => !m.dead);
  }

  detonate(m) {
    if (m.dead) return;
    m.dead = true;
    m.owner.activeMines = Math.max(0, m.owner.activeMines - 1);
    this.scene.remove(m.mesh);
    this.blast(m.x, m.z, m.owner);
    if (this.authoritative && this.onDetonate) this.onDetonate(m);
  }

  // Explosion, crates and shells are the same everywhere; only the host destroys tanks.
  blast(x, z, owner) {
    const g = this.game;
    g.effects.explosion(x, z, 1.15, 0.3);
    g.audio.boom(x, 0.5, z, 1);
    g.shakeFrom(x, z, 0.9);
    for (const c of g.world.blastCrates(x, z, MINE_BLAST)) g.effects.crateBurst(c);
    if (this.authoritative) {
      for (const t of g.tanks) {
        if (!t.alive || !g.canDamage(owner, t)) continue;
        if (Math.hypot(t.x - x, t.z - z) < MINE_BLAST + 0.35) g.tankHit(t, { kind: 'mine', by: owner });
      }
    }
    for (const s of this.shells) {
      if (s.alive && (s.x - x) ** 2 + (s.z - z) ** 2 < MINE_BLAST * MINE_BLAST) this.kill(s, 'blast');
    }
    for (const o of this.mines) {
      if (!o.dead && !o.triggered && (o.x - x) ** 2 + (o.z - z) ** 2 < MINE_BLAST * MINE_BLAST) { o.triggered = true; o.triggerT = 0.15; }
    }
  }

  // Host said a mine went off. If we never saw it laid, still play the blast where it was.
  detonateRemote(owner, id, x, z) {
    const m = this.mines.find((q) => !q.dead && q.owner === owner && q.id === id);
    if (m) this.detonate(m);
    else this.blast(x, z, owner);
  }
}
