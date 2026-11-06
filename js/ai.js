// Bot brain: plans ricochet shots, dodges shells, paths around cover and plays with mines.
import { SHELL_RADIUS, TANK_RADIUS, MINE_BLAST, MINE_TRIGGER } from './config.js';
import { wrapAngle, gaussian, segPointDist2, clamp } from './utils.js';
import { blocksShell } from './world.js';

const SELF_GRACE = 1.3;

export class Bot {
  constructor(game, tank, foe) {
    this.game = game;
    this.tank = tank;
    this.foe = foe;
    this.reset();
  }

  get p() { return this.tank.params; }

  reset() {
    this.time = 0;
    this.path = []; this.pathIdx = 0;
    this.goalT = 0;
    this.aimT = 0.6 + Math.random() * 0.4;  // short pause before the first shot
    this.solution = null;
    this.aimNoise = 0;
    this.dodge = null;
    this.threats = new WeakMap();
    this.stuckT = 0; this.unstick = null;
    this.mineCheckT = 0;
    this.intercept = null;
    this.hesitate = 0;
  }

  update(dt) {
    const me = this.tank;
    if (!me.alive) return;
    // multiplayer bots hunt whoever is closest (and not on their team)
    if (this.game.mp) {
      this.foeT = (this.foeT || 0) - dt;
      if (this.foeT <= 0 || !this.foe || !this.foe.alive) { this.foeT = 0.7; this.foe = this.game.mp.pickFoe(me); }
      if (!this.foe) { me.drive(dt, null, 0); return; }
    }
    const foe = this.foe, w = this.game.world;
    this.time += dt;
    const p = this.p;

    // ---------- movement ----------
    let moveYaw = null, throttle = 0;
    const mine = this.mineDanger();
    const threat = this.shellThreat();

    if (mine) {
      if (!this.fleePath || this.time > this.fleeRepath) { this.fleePath = this.safePath(); this.fleeRepath = this.time + 0.5; this.fleeIdx = 0; }
      moveYaw = this.follow(this.fleePath, 'fleeIdx');
      throttle = 1;
      if (moveYaw == null) moveYaw = Math.atan2(me.x - mine.x, me.z - mine.z);
    } else {
      this.fleePath = null;
      if (this.dodge && this.time < this.dodge.until) {
        moveYaw = this.dodge.yaw; throttle = 1;
      } else {
        this.dodge = null;
        if (threat && threat.react) {
          this.dodge = this.planDodge(threat);
          if (this.dodge) { moveYaw = this.dodge.yaw; throttle = 1; }
        }
      }
      if (moveYaw == null && this.unstick && this.time < this.unstick.until) {
        moveYaw = this.unstick.yaw; throttle = 0.8;
      }
      if (moveYaw == null) {
        this.goalT -= dt;
        if (this.goalT <= 0 || this.pathIdx >= this.path.length) this.chooseGoal();
        moveYaw = this.follow(this.path, 'pathIdx');
        throttle = moveYaw == null ? 0 : 1;
        // hold position when the shot is lined up (better aim), except for restless bots
        if (this.solution && foe.alive && p.aggression < 0.8 && Math.random() < 0.008) this.hesitate = 0.5;
        if (this.hesitate > 0) { this.hesitate -= dt; throttle = 0; }
      }
    }
    me.drive(dt, moveYaw, throttle);

    // stuck? back off in a random free direction
    if (Math.abs(me.targetSpeed) > 0.6 && (me.actualSpeed ?? 0) < 0.25) this.stuckT += dt; else this.stuckT = Math.max(0, this.stuckT - dt);
    if (this.stuckT > 0.9) {
      this.stuckT = 0;
      this.unstick = { yaw: me.hullYaw + Math.PI + (Math.random() - 0.5) * 2, until: this.time + 0.6 };
      this.goalT = 0;
    }

    // ---------- turret and gun ----------
    if (!foe.alive) { me.aimToward(dt, me.hullYaw, p.turretTurn * 0.5); return; }
    this.aimT -= dt;
    if (this.aimT <= 0) {
      this.aimT = p.aimInterval * (0.75 + Math.random() * 0.5);
      const sol = this.findSolution();
      if (sol && (!this.solution || Math.abs(wrapAngle(sol.yaw - this.solution.yaw)) > 0.05)) this.aimNoise = gaussian() * p.aimError;
      this.solution = sol;
    }

    // shoot down an incoming shell if it is about to hit and we cannot outrun it
    this.intercept = null;
    if (p.shootDown && threat && threat.react && threat.t > 0.3 && threat.t < 1.3 && threat.shell.owner !== me) {
      const yaw = this.interceptYaw(threat.shell);
      if (yaw != null && Math.abs(wrapAngle(yaw - me.turretYaw)) / p.turretTurn < threat.t * 0.55) this.intercept = yaw;
    }

    const proj = this.game.projectiles;
    if (this.intercept != null) {
      me.aimToward(dt, this.intercept, p.turretTurn * 1.2);
      if (Math.abs(wrapAngle(this.intercept - me.turretYaw)) < 0.04 && proj.canFire(me) && this.safeShot(me.turretYaw)) proj.fire(me);
    } else if (this.solution) {
      const want = this.solution.yaw + this.aimNoise;
      me.aimToward(dt, want, p.turretTurn);
      const err = Math.abs(wrapAngle(want - me.turretYaw));
      if (err < 0.03 && proj.canFire(me) && this.game.firing) {
        // precise bots re-check the plan; every bot refuses shots that would bounce back into itself
        const valid = p.aimError > 0.05 || this.verify(me.turretYaw - this.aimNoise);
        if (valid && this.safeShot(me.turretYaw)) { proj.fire(me); this.solution = null; this.aimT = Math.min(this.aimT, 0.15); }
      }
    } else {
      const yaw = Math.atan2(foe.x - me.x, foe.z - me.z);
      me.aimToward(dt, yaw + Math.sin(this.time * 0.7) * 0.15, p.turretTurn * 0.6);
    }

    // ---------- mines ----------
    this.mineCheckT -= dt;
    if (p.maxMines > 0 && this.mineCheckT <= 0) {
      this.mineCheckT = 0.25;
      const d = Math.hypot(foe.x - me.x, foe.z - me.z);
      const roll = Math.random() < p.mineRate * 0.25 * (1 + p.aggression);
      if (roll && d > 3.5 && d < 13 && me.activeMines < p.maxMines && (me.actualSpeed ?? 0) > 0.8) {
        if (proj.layMine(me)) this.goalT = 0;
      }
    }
  }

  // ---------- shooting ----------
  // Sweep turret angles, simulate each shell with ricochets, keep the quickest hit.
  findSolution() {
    const me = this.tank, foe = this.foe, p = this.p, w = this.game.world;
    const c = me.turretCenter();
    const maxB = Math.min(p.bank, p.bounces);
    const direct = Math.atan2(foe.x - c.x, foe.z - c.z);
    const angles = [];
    if (maxB === 0) { for (let k = -4; k <= 4; k++) angles.push(direct + k * 0.012); }
    else { for (let k = 0; k < 200; k++) angles.push((k / 200) * Math.PI * 2); for (let k = -4; k <= 4; k++) angles.push(direct + k * 0.012); }
    let best = null;
    for (const a of angles) {
      const r = this.simulate(c.x, c.z, a, 0.2, 44);
      if (r && (!best || r.score < best.score)) best = { ...r, yaw: a };
    }
    if (!best) return null;
    if (maxB > 0) { // refine around the coarse hit
      for (let k = -6; k <= 6; k++) {
        const a = best.yaw + k * 0.006;
        const r = this.simulate(c.x, c.z, a, 0.1, 44);
        if (r && r.score < best.score - 0.01) best = { ...r, yaw: a };
      }
    }
    return best;
  }

  // Simulate a shell with the bot's real bounce count; rejects paths that come back at the bot.
  simulate(x, z, yaw, step, maxDist) {
    const me = this.tank, foe = this.foe, p = this.p, w = this.game.world;
    const bounces = p.bounces;
    const s = { x, z, dx: Math.sin(yaw), dz: Math.cos(yaw), bounces, r: SHELL_RADIUS, travel: 0 };
    const lead = p.lead;
    const fvx = (foe.vx || 0) * lead, fvz = (foe.vz || 0) * lead;
    const hitR = Math.min(foe.halfWidth, foe.halfLength) + 0.1;
    while (s.travel < maxDist) {
      if (!w.advanceShell(s, step, step)) return null;
      const t = s.travel / p.shellSpeed;
      const fx = foe.x + fvx * t, fz = foe.z + fvz * t;
      if ((s.x - fx) ** 2 + (s.z - fz) ** 2 < hitR * hitR) {
        const used = bounces - s.bounces;
        return { score: s.travel + used * 5, travel: s.travel, bounces: used };
      }
      if ((s.bounces < bounces || s.travel > SELF_GRACE + me.muzzleForward) && (s.x - me.x) ** 2 + (s.z - me.z) ** 2 < 1.6) return null; // would come back at us
    }
    return null;
  }

  safeShot(yaw) {
    const me = this.tank, w = this.game.world, p = this.p;
    const c = me.turretCenter();
    const s = { x: c.x, z: c.z, dx: Math.sin(yaw), dz: Math.cos(yaw), bounces: p.bounces, r: SHELL_RADIUS, travel: 0 };
    while (s.travel < 40) {
      if (!w.advanceShell(s, 0.15, 0.15)) return true;
      if ((s.bounces < p.bounces || s.travel > SELF_GRACE + me.muzzleForward) && (s.x - me.x) ** 2 + (s.z - me.z) ** 2 < 1.8) return false;
      if (this.foe.alive && this.foe.hitTest(s.x, s.z, s.r)) return true;
    }
    return true;
  }

  verify(yaw) {
    const c = this.tank.turretCenter();
    return !!this.simulate(c.x, c.z, yaw, 0.1, 44);
  }

  interceptYaw(shell) {
    const me = this.tank, p = this.p;
    const m = me.turretCenter();
    let tx = shell.x, tz = shell.z;
    for (let i = 0; i < 4; i++) {
      const t = Math.hypot(tx - m.x, tz - m.z) / p.shellSpeed;
      tx = shell.x + shell.dx * shell.speed * t; tz = shell.z + shell.dz * shell.speed * t;
    }
    if (!this.game.world.lineClear(m.x, m.z, tx, tz, blocksShell, SHELL_RADIUS)) return null;
    return Math.atan2(tx - m.x, tz - m.z);
  }

  // ---------- threat handling ----------
  shellThreat() {
    const me = this.tank, w = this.game.world, p = this.p;
    let worst = null;
    for (const s of this.game.projectiles.shells) {
      if (!s.alive) continue;
      if (s.owner === me && s.travel < SELF_GRACE + 1 && s.bounces === s.startBounces) continue;
      const pts = w.tracePath(s.x, s.z, s.dx, s.dz, s.bounces, s.speed * 1.7, s.r, 0.15);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const { d2, t } = segPointDist2(a.x, a.z, b.x, b.z, me.x, me.z);
        if (d2 > 1.35 * 1.35) continue;
        const along = a.d + (b.d - a.d) * t;
        const time = along / s.speed;
        const len = Math.max(1e-4, Math.hypot(b.x - a.x, b.z - a.z));
        if (!worst || time < worst.t) {
          worst = { shell: s, t: time, px: a.x + (b.x - a.x) * t, pz: a.z + (b.z - a.z) * t, dx: (b.x - a.x) / len, dz: (b.z - a.z) / len };
        }
        break;
      }
    }
    if (!worst) return null;
    let rec = this.threats.get(worst.shell);
    if (!rec) { rec = { seen: this.time, notice: Math.random() < p.dodge }; this.threats.set(worst.shell, rec); }
    worst.react = rec.notice && this.time - rec.seen >= p.reaction;
    return worst;
  }

  planDodge(th) {
    const me = this.tank, w = this.game.world;
    let best = null;
    for (let k = 0; k < 16; k++) {
      const yaw = (k / 16) * Math.PI * 2;
      const dx = Math.sin(yaw), dz = Math.cos(yaw);
      // free to drive that way?
      let free = true;
      for (const step of [0.8, 1.6]) {
        const pos = { x: me.x + dx * step, z: me.z + dz * step };
        if (w.collideCircle(pos, TANK_RADIUS * 0.95) && Math.hypot(pos.x - me.x - dx * step, pos.z - me.z - dz * step) > 0.25) { free = false; break; }
      }
      if (!free) continue;
      // clearance from the shell line after moving
      const nx = me.x + dx * 1.6, nz = me.z + dz * 1.6;
      const side = Math.abs((nx - th.px) * -th.dz + (nz - th.pz) * th.dx);
      const toward = (dx * th.dx + dz * th.dz);   // moving along the shell's direction buys time too
      // hull alignment: forward or reverse, whichever is closer
      const diff = Math.abs(wrapAngle(yaw - me.hullYaw));
      const turn = Math.min(diff, Math.PI - diff);
      const score = side * 2 + toward * 0.5 - turn * 1.6;
      if (!best || score > best.score) best = { yaw, score };
    }
    if (!best) return null;
    return { yaw: best.yaw, until: this.time + clamp(th.t + 0.25, 0.35, 0.9) };
  }

  mineDanger() {
    const me = this.tank;
    let worst = null;
    for (const m of this.game.projectiles.mines) {
      const d = Math.hypot(m.x - me.x, m.z - me.z);
      const own = m.owner === me;
      const risky = own || m.triggered || m.fuse < 3;
      if (risky && d < MINE_BLAST + 1.1) { if (!worst || d < worst.d) worst = { x: m.x, z: m.z, d }; }
      else if (!own && d < MINE_TRIGGER + 1.0) { if (!worst || d < worst.d) worst = { x: m.x, z: m.z, d }; }
    }
    return worst;
  }

  // ---------- navigation ----------
  chooseGoal() {
    const me = this.tank, foe = this.foe, w = this.game.world, p = this.p;
    const { W, H } = w;
    this.goalT = 1.4 + Math.random() * 1.4;
    const mcx = w.toCellX(me.x), mcz = w.toCellZ(me.z);
    const candidates = [[mcx, mcz]];
    for (let i = 0; i < 36; i++) {
      const cx = clamp(mcx + Math.round((Math.random() - 0.5) * 16), 0, W - 1);
      const cz = clamp(mcz + Math.round((Math.random() - 0.5) * 12), 0, H - 1);
      if (w.walkable(cx, cz)) candidates.push([cx, cz]);
    }
    if (foe.alive) {
      const fcx = w.toCellX(foe.x), fcz = w.toCellZ(foe.z);
      for (let i = 0; i < 10; i++) {
        const cx = clamp(fcx + Math.round((Math.random() - 0.5) * 10), 0, W - 1);
        const cz = clamp(fcz + Math.round((Math.random() - 0.5) * 10), 0, H - 1);
        if (w.walkable(cx, cz)) candidates.push([cx, cz]);
      }
    }
    let best = null;
    for (const [cx, cz] of candidates) {
      const x = w.centerX(cx), z = w.centerZ(cz);
      const dFoe = Math.hypot(foe.x - x, foe.z - z);
      let score = -Math.abs(dFoe - p.preferDist) * 0.8;
      const los = w.lineClear(x, z, foe.x, foe.z, blocksShell, 0.15);
      score += los ? 5 * p.aggression - 1.5 : 0;
      if (me.cooldown > 0.3 && los) score -= 2 * (1 - p.aggression);
      score -= Math.hypot(me.x - x, me.z - z) * 0.18;
      for (const m of this.game.projectiles.mines) if (Math.hypot(m.x - x, m.z - z) < MINE_BLAST + 0.8) score -= 12;
      score += (Math.random() - 0.5) * 3;
      if (!best || score > best.score) best = { cx, cz, score };
    }
    this.path = this.astar(mcx, mcz, best.cx, best.cz) || [];
    this.pathIdx = 0;
  }

  // Waypoint following with simple look-ahead smoothing. Returns a drive yaw or null.
  follow(path, idxKey) {
    if (!path || !path.length) return null;
    const me = this.tank, w = this.game.world;
    let i = this[idxKey] || 0;
    while (i < path.length && Math.hypot(path[i].x - me.x, path[i].z - me.z) < 0.6) i++;
    while (i + 1 < path.length && this.walkLine(me.x, me.z, path[i + 1].x, path[i + 1].z)) i++;
    this[idxKey] = i;
    if (i >= path.length) return null;
    return Math.atan2(path[i].x - me.x, path[i].z - me.z);
  }

  walkLine(ax, az, bx, bz) {
    const w = this.game.world;
    const len = Math.hypot(bx - ax, bz - az), n = Math.ceil(len / 0.4);
    for (let k = 1; k <= n; k++) {
      const t = k / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      for (const [ox, oz] of [[0, 0], [0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8]]) {
        if (!w.walkable(w.toCellX(x + ox), w.toCellZ(z + oz))) return false;
      }
    }
    return true;
  }

  cellCost(cx, cz) {
    const w = this.game.world;
    let c = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!w.walkable(cx + dx, cz + dz)) c += 0.35;
    const x = w.centerX(cx), z = w.centerZ(cz);
    for (const m of this.game.projectiles.mines) {
      const d = Math.hypot(m.x - x, m.z - z);
      if (m.owner !== this.tank && d < MINE_TRIGGER + 0.9) c += 60;
      else if (d < MINE_BLAST + 0.5) c += 14;
    }
    return c;
  }

  astar(sx, sz, gx, gz) {
    const w = this.game.world;
    const { W, H } = w;
    if (!w.walkable(gx, gz)) return null;
    const N = W * H, g = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
    const open = [];
    const s = sz * W + sx, goal = gz * W + gx;
    g[s] = 0; open.push(s);
    const hFn = (i) => Math.hypot((i % W) - gx, Math.floor(i / W) - gz);
    while (open.length) {
      let bi = 0;
      for (let k = 1; k < open.length; k++) if (g[open[k]] + hFn(open[k]) < g[open[bi]] + hFn(open[bi])) bi = k;
      const cur = open.splice(bi, 1)[0];
      if (cur === goal) break;
      closed[cur] = 1;
      const cx = cur % W, cz = Math.floor(cur / W);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = cx + dx, nz = cz + dz;
        if (!w.walkable(nx, nz)) continue;
        if (dx && dz && (!w.walkable(cx + dx, cz) || !w.walkable(cx, cz + dz))) continue;
        const ni = nz * W + nx;
        if (closed[ni]) continue;
        const ng = g[cur] + (dx && dz ? 1.414 : 1) + this.cellCost(nx, nz);
        if (ng < g[ni]) { g[ni] = ng; from[ni] = cur; if (!open.includes(ni)) open.push(ni); }
      }
    }
    if (from[goal] === -1 && goal !== s) return null;
    const path = [];
    for (let i = goal; i !== -1 && i !== s; i = from[i]) path.push({ x: w.centerX(i % W), z: w.centerZ(Math.floor(i / W)) });
    return path.reverse();
  }

  // Path to the nearest cell outside every dangerous blast radius.
  safePath() {
    const me = this.tank, w = this.game.world;
    const { W, H } = w;
    const mines = this.game.projectiles.mines;
    const safe = (cx, cz) => {
      const x = w.centerX(cx), z = w.centerZ(cz);
      return mines.every((m) => Math.hypot(m.x - x, m.z - z) > MINE_BLAST + 1.2);
    };
    const sx = w.toCellX(me.x), sz = w.toCellZ(me.z);
    const from = new Int32Array(W * H).fill(-2);
    const q = [sz * W + sx];
    from[q[0]] = -1;
    while (q.length) {
      const cur = q.shift();
      const cx = cur % W, cz = Math.floor(cur / W);
      if (safe(cx, cz)) {
        const path = [];
        for (let i = cur; i !== -1; i = from[i]) path.push({ x: w.centerX(i % W), z: w.centerZ(Math.floor(i / W)) });
        return path.reverse();
      }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = cx + dx, nz = cz + dz;
        if (!w.walkable(nx, nz) || from[nz * W + nx] !== -2) continue;
        if (dx && dz && (!w.walkable(cx + dx, cz) || !w.walkable(cx, cz + dz))) continue;
        from[nz * W + nx] = cur;
        q.push(nz * W + nx);
      }
    }
    return [];
  }
}
