// Multiplayer session: lobby, chat, host-run round flow and network sync.
//
// Every player publishes one small state object (see net.js):
//   n name, c colour index, t team choice, r ready, k tank pose, s recent shots, m recent mines, ch recent chat
// The host also publishes:
//   H  match state (settings, slots, phase, round, seed, spawns, lives, alive flags, scores)
//   E  recent events (kills, shell removals, mine blasts), B bot poses, BS/BM bot shots/mines, T phase timer
// Rings carry increasing ids, so a dropped update never loses a shot, a kill or a chat line.
import { Tank } from './tank.js';
import { Bot } from './ai.js';
import { PLAYER, BOTS } from './config.js';
import { wrapAngle } from './utils.js';

export const PALETTE = [0x5f7f3a, 0x3e6db5, 0xb23b2e, 0xd1a12f, 0x7a4bb0, 0x2f9e9a, 0xd06a28, 0xd8d4c8];
export const PALETTE_NAMES = ['Olive', 'Blue', 'Red', 'Yellow', 'Purple', 'Teal', 'Orange', 'Bone'];
export const TEAM_COLORS = [0x3e6db5, 0xb23b2e];
export const TEAM_NAMES = ['Blue', 'Red'];
export const DEFAULT_SETTINGS = {
  md: 0,          // 0 last tank standing (rounds), 1 deathmatch (respawns)
  tm: 0,          // 0 free-for-all, 1 two teams
  rw: 5,          // round wins needed
  kl: 15,         // kill limit (deathmatch)
  cd: 0.24,       // shot delay, seconds
  ms: 5,          // shells in the air per tank
  bn: 1,          // ricochets per shell
  ss: 1,          // shell speed index
  mn: 2,          // mines per tank
  mk: 1,          // opponent markers: 0 off, 1 in sight, 2 always
  al: 1,          // aim line allowed
  tw: 1,          // incoming-shell warnings
  ff: 0,          // friendly fire (teams)
  nb: 0,          // bots
  bd: 'regular',  // bot difficulty
  vs: 1,          // tank speed multiplier
  sz: 'medium',   // arena size (see SIZES in config.js)
};
export const SHELL_SPEEDS = [8, 11.5, 16, 22];
const MAX_TANKS = 8;
const COUNTDOWN = 3.2, ROUND_OVER = 3.6, RESPAWN = 3;
const INTERP_DELAY = 110; // ms behind the newest sample
const BOT_MODELS = ['desert', 'scout', 'heavy'];
const SPAWN_ORDER_FFA = [0, 1, 2, 3, 6, 7, 4, 5];
const SPAWN_TEAM = [[6, 0, 3, 4], [7, 1, 2, 5]];

const r2 = (v) => Math.round(v * 100);
const r3 = (v) => Math.round(v * 1000);
const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;

export function sanitizeText(s, max) {
  // drop control and invisible formatting characters (zero-width, bidi marks, line separators)
  let out = '';
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0xad || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff) continue;
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

export function playerParams(st) {
  return { speed: PLAYER.speed * st.vs, reverseSpeed: PLAYER.reverseSpeed * st.vs, hullTurn: PLAYER.hullTurn,
    shellSpeed: SHELL_SPEEDS[st.ss] ?? 11.5, bounces: st.bn, maxShells: st.ms, cooldown: st.cd, maxMines: st.mn };
}

function botParams(st, diff) {
  const b = BOTS[diff] || BOTS.regular;
  return { ...b, speed: b.speed * st.vs, bounces: st.bn, shellSpeed: SHELL_SPEEDS[st.ss] ?? 11.5,
    maxShells: Math.min(b.maxShells, st.ms), cooldown: Math.max(b.cooldown, st.cd), maxMines: Math.min(b.maxMines, st.mn) };
}

export class MpSession {
  constructor(game, net, { code, isHost, name, color, settings }) {
    this.game = game;
    this.net = net;
    this.code = code;
    this.isHost = isHost;
    this.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    this.phase = 'lb';
    this.round = 0; this.seed = 0;
    this.inGame = false;
    this.slots = {};            // peerId -> slot, from the host
    this.tanks = new Map();     // slot -> Tank
    this.remote = new Map();    // slot -> interpolation buffer
    this.lives = {};
    this.chat = [];
    this.seen = new Map();      // ring cursors: `${owner}:${ring}` -> last id handled
    this.lastEvent = null;
    this.myShots = []; this.myMines = []; this.myChat = []; this.chatSeq = 0;
    this.known = new Map();     // peerId -> name, for join/leave lines
    this.hostMissing = 0; this.everSawHost = false;
    this.phaseLeft = 0; this.lastCount = 0;
    this.ended = false;
    this.version = 0;           // bumps whenever lobby-visible data changes
    // host-only state
    this.H = null;
    this.events = []; this.eventSeq = 0;
    this.alive = new Set();
    this.respawnAt = new Map();
    this.bots = [];
    this.botShots = []; this.botMines = [];
    this.lastT = -1;
    this.advertiseT = 0;

    net.setState({ v: 1, n: name, c: color, t: 0, r: 0, k: null, s: [], m: [], ch: [] });
    if (isHost) {
      this.H = { v: 1, code, st: this.settings, ph: 'lb', rd: 0, sd: 0, sl: {}, nm: {}, cl: {}, tm: {}, bo: {}, sp: {}, lf: {}, al: {}, sc: {}, ts: [0, 0], wn: null };
      this.publishHost();
    }
  }

  // ---------- small accessors ----------
  get me() { return this.net.me; }
  get mySlot() { const s = this.slots[this.net.myId]; return s == null ? null : s; }
  hasSlot() { return this.mySlot != null; }
  hostState() { return this.isHost ? this.net.me : this.hostPeer && this.hostPeer.state; }
  canDrive() { return this.inGame && this.hasSlot() && this.game.player.alive && (this.phase === 'pl' || this.phase === 'ro'); }
  canFire() { return this.inGame && this.hasSlot() && this.game.player.alive && this.phase === 'pl'; }
  teamOf(slot) { const H = this.hostState()?.H; return this.settings.tm ? (H?.tm?.[slot] ?? 0) : slot; }
  nameOf(slot) {
    const H = this.hostState()?.H;
    if (!H) return 'Tank';
    if (H.nm && H.nm[slot]) return H.nm[slot];
    for (const [pid, s] of Object.entries(H.sl || {})) if (s === slot) { const p = this.net.peers().get(pid); if (p && p.state.n) return p.state.n; }
    return 'Tank';
  }
  colorOf(slot) { const H = this.hostState()?.H; return H?.cl?.[slot] ?? PALETTE[slot % PALETTE.length]; }

  canDamage(a, b) {
    if (!a || !b || a === b || !this.settings.tm || this.settings.ff) return true;
    return a.team !== b.team;
  }

  pickFoe(tank) {
    let best = null, bd = Infinity;
    for (const t of this.game.tanks) {
      if (t === tank || !t.alive || !this.canDamage(tank, t)) continue;
      const d = (t.x - tank.x) ** 2 + (t.z - tank.z) ** 2;
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  // ---------- frame ----------
  update(dt) {
    if (this.ended) return;
    const peers = this.net.peers();
    this.trackPeers(peers);

    let host = null;
    if (this.isHost) host = { id: this.net.myId, isMe: true, state: this.net.me };
    else for (const p of peers.values()) if (!p.isMe && p.state.H && p.state.H.code === this.code) { host = p; break; }
    this.hostPeer = host;
    if (!host || !this.net.connected()) {
      this.hostMissing += dt;
      if (this.hostMissing > (this.everSawHost ? 6 : 10)) { this.end(this.everSawHost ? 'The host left the game.' : 'No lobby found with that code.'); return; }
    } else { this.hostMissing = 0; this.everSawHost = true; }

    if (host && host.state.H) this.applyHost(host.state);
    for (const p of peers.values()) {
      if (p.isMe) continue;
      this.readChat(p);
      if (this.inGame) { this.readShots(p); this.readMines(p); }
    }
    if (this.inGame && host && !host.isMe) this.readBots(host.state);
    if (this.inGame) this.updateRemoteTanks(dt, peers);
    if (this.isHost) this.hostTick(dt, peers);
    this.phaseLeft = Math.max(0, this.phaseLeft - dt);
    if (this.inGame && this.phase === 'cd') this.countdownBanners();
    this.publishMe();
  }

  trackPeers(peers) {
    for (const p of peers.values()) {
      if (p.isMe || !p.state.n) continue;
      if (!this.known.has(p.id)) { this.known.set(p.id, p.state.n); if (this.everSawHost || this.isHost) this.system(`${p.state.n} joined`); this.version++; }
      else if (this.known.get(p.id) !== p.state.n) { this.known.set(p.id, p.state.n); this.version++; }
    }
    for (const [id, name] of this.known) {
      if (!peers.has(id)) {
        this.known.delete(id);
        this.system(`${name} left`);
        this.version++;
        if (this.isHost) this.hostDropPlayer(id);
      }
    }
  }

  // ---------- applying the host's state (everyone, host included) ----------
  applyHost(state) {
    const H = state.H;
    const prevSettings = JSON.stringify(this.settings);
    this.settings = { ...DEFAULT_SETTINGS, ...(H.st || {}) };
    if (JSON.stringify(this.settings) !== prevSettings) this.version++;
    const slotsBefore = JSON.stringify(this.slots);
    this.slots = H.sl || {};
    if (JSON.stringify(this.slots) !== slotsBefore) this.version++;

    const slotsChanged = JSON.stringify(this.slots) !== slotsBefore;
    if (H.ph !== 'lb' && H.ph !== 'rs' && (H.rd !== this.round || H.sd !== this.seed)) this.startRoundLocal(H);
    else if (this.inGame && (slotsChanged || JSON.stringify(H.bo || {}) !== this.botsSig)) this.syncRoster(H);
    this.botsSig = JSON.stringify(H.bo || {});
    if (H.ph !== this.phase) this.enterPhase(H.ph, H);
    if (this.inGame) this.reconcile(H);
    this.readEvents(state.E || []);
    if (typeof state.T === 'number' && !this.isHost) {
      const t = state.T / 10;
      if (Math.abs(t - this.phaseLeft) > 0.35) this.phaseLeft = t;
    }
  }

  startRoundLocal(H) {
    const g = this.game;
    this.round = H.rd; this.seed = H.sd;
    if (!this.inGame) { this.inGame = true; g.enterMpMatch(); }
    g.effects.clear();
    g.projectiles.clear();
    g.useSize(this.settings.sz);
    this.spawns = g.world.generateMulti(H.sd);
    g.world.build();
    this.syncRoster(H);
    for (const [slot, t] of this.tanks) {
      const sp = this.spawns[H.sp?.[slot] ?? 0];
      t.reset(sp.x, sp.z, sp.yaw);
      this.lives[slot] = H.lf?.[slot] ?? 0;
      this.remote.delete(slot);
    }
    const mine = this.mySlot;
    if (mine != null) {
      const sp = this.spawns[H.sp?.[mine] ?? 0];
      g.lookYaw = sp.yaw; g.lookPitch = -0.04; g.deathCam = null;
    }
    for (const b of this.bots) b.ai.reset();
    this.lastCount = 9;
    if (!this.isHost) this.phaseLeft = COUNTDOWN;
  }

  // Create, recolour and drop tanks so they match the host's slot list.
  syncRoster(H) {
    const g = this.game;
    const st = this.settings;
    const want = new Map();
    for (const [pid, slot] of Object.entries(H.sl || {})) want.set(slot, { pid });
    for (const [s, b] of Object.entries(H.bo || {})) want.set(+s, { bot: b });
    for (const [slot, t] of this.tanks) {
      if (!want.has(slot) || (t === g.player && this.mySlot !== slot)) {
        if (t !== g.player) g.scene.remove(t.root);
        this.tanks.delete(slot);
      }
    }
    const myPid = this.net.myId;
    for (const [slot, w] of want) {
      let t = this.tanks.get(slot);
      const color = H.cl?.[slot] ?? PALETTE[slot % PALETTE.length];
      if (!t) {
        if (w.pid === myPid) t = g.player;
        else if (w.bot) t = new Tank({ model: w.bot.m, paint: w.bot.p, params: botParams(st, w.bot.d), isPlayer: false, label: w.bot.n });
        else t = new Tank({ model: 'olive', paint: color, params: playerParams(st), isPlayer: false, label: '' });
        if (t !== g.player) g.scene.add(t.root);
        this.tanks.set(slot, t);
        // joined mid-round (deathmatch): put it at its spawn right away
        const sp = this.spawns && this.spawns[H.sp?.[slot] ?? 0];
        if (sp && this.round) {
          t.reset(sp.x, sp.z, sp.yaw);
          this.lives[slot] = H.lf?.[slot] ?? 0;
          if (t === g.player) { g.lookYaw = sp.yaw; g.deathCam = null; }
        }
      }
      t.slot = slot;
      t.team = H.tm?.[slot] ?? 0;
      t.remote = !(t === g.player || (w.bot && this.isHost));
      if (w.bot) { t.params = botParams(st, w.bot.d); t.isBot = true; }
      else { t.params = playerParams(st); t.isBot = false; t.repaint(color); }
      t.root.visible = true;
    }
    // bot brains live on the host only
    if (this.isHost) {
      this.bots = this.bots.filter((b) => this.tanks.get(b.slot) === b.tank);
      for (const [slot, w] of want) {
        if (!w.bot || this.bots.some((b) => b.slot === slot)) continue;
        const tank = this.tanks.get(slot);
        this.bots.push({ slot, tank, ai: new Bot(g, tank, null) });
      }
    }
    g.player.root.visible = this.mySlot != null;
    g.tanks = [...this.tanks.values()];
  }

  enterPhase(ph, H) {
    const g = this.game, hud = g.hud;
    this.phase = ph;
    this.version++;
    if (ph === 'lb') {
      if (this.inGame) { this.inGame = false; this.clearMatch(); }
      g.mpUi.showLobby();
      return;
    }
    if (!this.inGame) return; // late joiner waits for the next round start
    if (ph !== 'rs') g.mpUi.hideResults();
    if (ph === 'cd') {
      const target = this.settings.md ? `FIRST TO ${this.settings.kl} KILLS` : `FIRST TO ${this.settings.rw} ROUNDS`;
      hud.banner(this.settings.md ? 'DEATHMATCH' : `ROUND ${H.rd}`, this.hasSlot() ? target : 'Spectating until the next round', 1.2);
      g.audio.play('round_start', { volume: 0.5 });
    } else if (ph === 'pl') {
      hud.banner('FIGHT', '', 0.8, 'count');
      g.audio.play('countdown', { volume: 0.8, rate: 1.5 });
    } else if (ph === 'ro') {
      const w = H.wn;
      const mine = this.mySlot;
      let big = 'ROUND OVER', small = '', tone = '';
      if (w && w.t >= 0 && this.settings.tm) { big = `${TEAM_NAMES[w.t].toUpperCase()} TEAM WINS`; tone = mine != null && this.teamOf(mine) === w.t ? 'win' : 'loss'; }
      else if (w && w.s >= 0) { big = w.s === mine ? 'YOU WIN THE ROUND' : `${this.nameOf(w.s).toUpperCase()} WINS`; tone = w.s === mine ? 'win' : 'loss'; }
      else small = 'Nobody survived';
      hud.banner(big, small, 2.8, tone);
      g.audio.play(tone === 'win' ? 'win' : 'lose', { volume: 0.6 });
    } else if (ph === 'rs') {
      g.mpUi.showResults(this.standings(), this.resultTitle());
      g.audio.play(this.iWon() ? 'win' : 'lose', { volume: 0.7 });
    }
  }

  countdownBanners() {
    const n = Math.ceil(this.phaseLeft / 0.75);
    if (this.phaseLeft <= 2.25 && n !== this.lastCount && n >= 1) {
      this.lastCount = n;
      this.game.hud.banner(String(n), '', 0.7, 'count');
      this.game.audio.play('countdown', { volume: 0.6 });
    }
  }

  // State-based safety net for dropped events: respawns and deaths follow H.
  reconcile(H) {
    for (const [slot, t] of this.tanks) {
      const life = H.lf?.[slot] ?? 0;
      if (life !== (this.lives[slot] ?? 0)) {
        this.lives[slot] = life;
        const sp = this.spawns[H.sp?.[slot] ?? 0];
        t.reset(sp.x, sp.z, sp.yaw);
        this.remote.delete(slot);
        if (t === this.game.player) { this.game.lookYaw = sp.yaw; this.game.deathCam = null; this.game.hud.feed('Respawned'); }
      }
      if (H.al && H.al[slot] === 0 && t.alive) this.destroyTank(t);
    }
  }

  readEvents(E) {
    if (this.lastEvent == null) { this.lastEvent = E.reduce((m, e) => Math.max(m, e[0]), 0); return; }
    for (const ev of E) {
      if (ev[0] <= this.lastEvent) continue;
      this.lastEvent = ev[0];
      if (!this.isHost) this.applyEvent(ev);
    }
  }

  applyEvent(ev) {
    const g = this.game;
    const type = ev[1];
    if (type === 'k') {
      const [, , victim, killer, cause, shotOwner, shotId] = ev;
      const owner = this.tanks.get(shotOwner);
      if (owner && shotId) g.projectiles.removeShell(owner, shotId, 'silent');
      const t = this.tanks.get(victim);
      if (t) this.destroyTank(t);
      this.killFeed(victim, killer, cause);
    } else if (type === 'x') {
      const owner = this.tanks.get(ev[2]);
      if (owner) g.projectiles.removeShell(owner, ev[3], ev[4] === 1 ? 'clash' : 'remote');
    } else if (type === 'd') {
      const owner = this.tanks.get(ev[2]);
      g.projectiles.detonateRemote(owner || null, ev[3], ev[4] / 100, ev[5] / 100);
    }
  }

  destroyTank(t) {
    if (!t.alive) return;
    const g = this.game;
    t.wreck();
    t.smokeT = 0;
    g.effects.explosion(t.x, t.z, 1.3, 0.75);
    g.effects.tankBurst(t.x, t.z);
    g.audio.boom(t.x, 0.8, t.z, 1.25);
    g.shakeFrom(t.x, t.z, 1.1);
  }

  killFeed(victim, killer, cause) {
    const vn = this.nameOf(victim), kn = this.nameOf(killer);
    const mine = this.mySlot;
    const tone = victim === mine ? 'loss' : killer === mine ? 'win' : '';
    let text;
    if (killer === victim || killer < 0) text = cause === 2 ? `${vn} caught their own mine` : `${vn} was hit by their own ricochet`;
    else text = `${kn} ${cause === 2 ? 'mined' : cause === 1 ? 'banked a shot into' : 'hit'} ${vn}`;
    this.game.hud.feed(text, tone);
    if (victim === mine) this.game.hud.banner('DESTROYED', killer === victim || killer < 0 ? 'Your own fire' : `by ${kn}`, 2, 'loss');
  }

  // ---------- reading other players ----------
  ring(owner, key, list, fn) {
    if (!Array.isArray(list)) return;
    const k = owner + ':' + key;
    const last = this.seen.get(k);
    let max = last ?? 0;
    if (last == null) { // first sight (even of an empty list): skip what was already there
      for (const e of list) max = Math.max(max, e[0] ?? 0);
      this.seen.set(k, max);
      return;
    }
    for (const e of list) {
      if (!Array.isArray(e) || !(e[0] > last)) continue;
      fn(e);
      max = Math.max(max, e[0]);
    }
    this.seen.set(k, max);
  }

  readChat(p) {
    this.ring(p.id, 'ch', p.state.ch, (e) => {
      const text = sanitizeText(e[1], 120);
      if (text) this.addChat(sanitizeText(p.state.n, 16) || 'Player', PALETTE[(p.state.c | 0) % PALETTE.length], text);
    });
  }

  readShots(p) {
    const slot = this.slots[p.id];
    const t = slot == null ? null : this.tanks.get(slot);
    this.ring(p.id, 's', p.state.s, (e) => { if (t) this.game.projectiles.fireFrom(t, e[1] / 100, e[2] / 100, e[3] / 1000, e[0]); });
  }

  readMines(p) {
    const slot = this.slots[p.id];
    const t = slot == null ? null : this.tanks.get(slot);
    this.ring(p.id, 'm', p.state.m, (e) => { if (t) this.game.projectiles.layMineAt(t, e[1] / 100, e[2] / 100, e[0]); });
  }

  readBots(hs) {
    for (const e of hs.B || []) this.pushSample(e[0], e.slice(1));
    const shots = new Map(), mines = new Map();
    for (const e of hs.BS || []) { if (!shots.has(e[0])) shots.set(e[0], []); shots.get(e[0]).push(e.slice(1)); }
    for (const e of hs.BM || []) { if (!mines.has(e[0])) mines.set(e[0], []); mines.get(e[0]).push(e.slice(1)); }
    for (const [slot, list] of shots) {
      const t = this.tanks.get(slot);
      this.ring('bot' + slot, 's', list, (e) => { if (t) this.game.projectiles.fireFrom(t, e[1] / 100, e[2] / 100, e[3] / 1000, e[0]); });
    }
    for (const [slot, list] of mines) {
      const t = this.tanks.get(slot);
      this.ring('bot' + slot, 'm', list, (e) => { if (t) this.game.projectiles.layMineAt(t, e[1] / 100, e[2] / 100, e[0]); });
    }
  }

  // ---------- remote tank smoothing ----------
  pushSample(slot, k) {
    if (!Array.isArray(k) || k.length < 8) return;
    let r = this.remote.get(slot);
    if (!r) { r = { samples: [], offset: null, lastT: null }; this.remote.set(slot, r); }
    const t = k[7];
    if (t === r.lastT) return;
    r.lastT = t;
    const now = performance.now();
    const off = now - t;
    if (r.offset == null || off < r.offset) r.offset = off;
    else r.offset += (off - r.offset) * 0.01;
    r.samples.push({ t, x: k[0] / 100, z: k[1] / 100, hy: k[2] / 1000, ty: k[3] / 1000, sp: k[4] / 100, tr: k[5] / 100 });
    if (r.samples.length > 30) r.samples.shift();
  }

  updateRemoteTanks(dt, peers) {
    for (const p of peers.values()) {
      if (p.isMe) continue;
      const slot = this.slots[p.id];
      if (slot != null && p.state.k) this.pushSample(slot, p.state.k);
    }
    const now = performance.now();
    for (const [slot, t] of this.tanks) {
      if (!t.remote || !t.alive) continue;
      const r = this.remote.get(slot);
      if (!r || !r.samples.length) continue;
      const target = now - r.offset - INTERP_DELAY;
      const s = r.samples;
      let a = s[0], b = s[0];
      if (target >= s[s.length - 1].t) {
        a = b = s[s.length - 1];
        const prev = s.length > 1 ? s[s.length - 2] : null;
        const ahead = Math.min(150, target - b.t) / 1000;
        if (prev && b.t > prev.t && ahead > 0) {
          const k = 1000 / (b.t - prev.t);
          t.applyNet(dt, b.x + (b.x - prev.x) * k * ahead, b.z + (b.z - prev.z) * k * ahead, b.hy, b.ty, b.sp, b.tr, this.game.effects);
          continue;
        }
      } else {
        for (let i = s.length - 1; i > 0; i--) if (s[i - 1].t <= target) { a = s[i - 1]; b = s[i]; break; }
      }
      const f = b.t > a.t ? Math.min(1, Math.max(0, (target - a.t) / (b.t - a.t))) : 1;
      t.applyNet(dt, a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f, lerpAngle(a.hy, b.hy, f), lerpAngle(a.ty, b.ty, f),
        a.sp + (b.sp - a.sp) * f, a.tr + (b.tr - a.tr) * f, this.game.effects);
    }
  }

  // ---------- publishing my state ----------
  publishMe() {
    const g = this.game, me = g.player;
    const k = this.inGame && this.hasSlot()
      ? [r2(me.x), r2(me.z), r3(me.hullYaw), r3(me.turretYaw), r2(me.speed), r2(me.turnRate), me.alive ? 1 : 0, Math.round(performance.now())]
      : null;
    if (k || this.me.k) this.net.setState({ k });
  }

  // projectile hooks
  onFire(tank, s) {
    const g = this.game;
    if (!this.inGame) return; // the attract scene behind the lobby fires too
    if (tank === g.player) {
      // the origin the shell started from (before it travelled out to the muzzle)
      this.myShots.push([s.id, r2(s.ox), r2(s.oz), r3(s.yaw)]);
      if (this.myShots.length > 6) this.myShots.shift();
      this.net.setState({ s: this.myShots.slice() });
    } else if (this.isHost && tank.isBot) {
      this.botShots.push([tank.slot, s.id, r2(s.ox), r2(s.oz), r3(s.yaw)]);
      if (this.botShots.length > 8) this.botShots.shift();
      this.net.setState({ BS: this.botShots.slice() });
    }
  }

  onMine(tank, m) {
    const g = this.game;
    if (!this.inGame) return;
    if (tank === g.player) {
      this.myMines.push([m.id, r2(m.x), r2(m.z)]);
      if (this.myMines.length > 3) this.myMines.shift();
      this.net.setState({ m: this.myMines.slice() });
    } else if (this.isHost && tank.isBot) {
      this.botMines.push([tank.slot, m.id, r2(m.x), r2(m.z)]);
      if (this.botMines.length > 4) this.botMines.shift();
      this.net.setState({ BM: this.botMines.slice() });
    }
  }

  // ---------- chat ----------
  sendChat(text) {
    const clean = sanitizeText(text, 120);
    if (!clean) return;
    const now = performance.now();
    if (now - (this.lastChat || 0) < 600) return;
    this.lastChat = now;
    this.myChat.push([++this.chatSeq, clean]);
    if (this.myChat.length > 3) this.myChat.shift();
    this.net.setState({ ch: this.myChat.slice() });
    this.addChat(sanitizeText(this.me.n, 16), PALETTE[(this.me.c | 0) % PALETTE.length], clean, true);
  }

  addChat(name, color, text, mine = false) {
    this.chat.push({ name, color, text, mine, at: performance.now() });
    if (this.chat.length > 60) this.chat.shift();
    this.version++;
    this.game.mpUi?.onChat(this.chat[this.chat.length - 1]);
  }

  system(text) {
    this.chat.push({ sys: true, text, at: performance.now() });
    if (this.chat.length > 60) this.chat.shift();
    this.version++;
    this.game.mpUi?.onChat(this.chat[this.chat.length - 1]);
  }

  // ---------- lobby actions ----------
  setProfile(patch) { this.net.setState(patch); this.version++; }

  setSettings(patch) {
    if (!this.isHost) return;
    this.settings = { ...this.settings, ...patch };
    this.H.st = this.settings;
    this.publishHost();
    this.version++;
  }

  lobbyPlayers() {
    const out = [];
    for (const p of this.net.peers().values()) {
      if (!p.state.n) continue;
      out.push({ id: p.id, name: sanitizeText(p.state.n, 16) || 'Player', color: PALETTE[(p.state.c | 0) % PALETTE.length], colorIndex: p.state.c | 0,
        team: p.state.t ? 1 : 0, ready: !!p.state.r, isMe: p.isMe, isHost: this.isHost ? p.isMe : !!(p.state.H && p.state.H.code === this.code) });
    }
    out.sort((a, b) => (b.isHost - a.isHost) || a.id.localeCompare(b.id));
    return out;
  }

  // ---------- host ----------
  publishHost() {
    if (!this.isHost) return;
    this.net.setState({ H: JSON.parse(JSON.stringify(this.H)) });
  }

  pushEvent(ev) {
    this.events.push([++this.eventSeq, ...ev]);
    if (this.events.length > 12) this.events.shift();
    this.net.setState({ E: this.events.slice() });
  }

  humans(peers) {
    return [...peers.values()].filter((p) => p.state.n).sort((a, b) => (b.isMe - a.isMe) || a.id.localeCompare(b.id));
  }

  hostStart() {
    if (!this.isHost) return;
    const peers = this.net.peers();
    const st = this.settings;
    const H = this.H;
    H.sl = {}; H.nm = {}; H.cl = {}; H.tm = {}; H.bo = {}; H.sc = {}; H.ts = [0, 0]; H.wn = null;
    this.bots = [];
    const humans = this.humans(peers).slice(0, MAX_TANKS);
    const used = new Set();
    humans.forEach((p, i) => {
      H.sl[p.id] = i;
      H.tm[i] = st.tm ? (p.state.t ? 1 : 0) : 0;
      let c = (p.state.c | 0) % PALETTE.length;
      while (used.has(c)) c = (c + 1) % PALETTE.length;
      used.add(c);
      H.cl[i] = st.tm ? TEAM_COLORS[H.tm[i]] : PALETTE[c];
      H.sc[i] = 0;
    });
    const nb = Math.min(st.nb, MAX_TANKS - humans.length);
    const teamCount = [0, 0];
    humans.forEach((_, i) => teamCount[H.tm[i]]++);
    for (let b = 0; b < nb; b++) {
      const slot = humans.length + b;
      const team = st.tm ? (teamCount[0] <= teamCount[1] ? 0 : 1) : 0;
      teamCount[team]++;
      let c = 0;
      while (used.has(c) && c < PALETTE.length - 1) c++;
      used.add(c);
      const paint = st.tm ? TEAM_COLORS[team] : PALETTE[c];
      H.bo[slot] = { n: `BOT ${b + 1}`, m: BOT_MODELS[b % BOT_MODELS.length], p: paint, d: st.bd };
      H.nm[slot] = `BOT ${b + 1}`;
      H.tm[slot] = team;
      H.cl[slot] = paint;
      H.sc[slot] = 0;
    }
    this.hostNewRound(1);
  }

  allSlots() { return [...Object.values(this.H.sl), ...Object.keys(this.H.bo).map(Number)]; }

  hostNewRound(rd) {
    const H = this.H;
    // late joiners get a slot at the start of a round
    if (rd > 1) this.admitLateJoiners();
    H.rd = rd;
    H.sd = (Math.random() * 2 ** 31) | 0;
    H.ph = 'cd';
    H.wn = null;
    H.lf = {}; H.al = {}; H.sp = {};
    const slots = this.allSlots();
    if (this.settings.tm) {
      const next = [0, 0];
      for (const s of slots) { const tm = H.tm[s] ?? 0; H.sp[s] = SPAWN_TEAM[tm][next[tm]++ % 4]; }
    } else {
      const order = slots.length <= 2 ? [6, 7] : SPAWN_ORDER_FFA;
      slots.forEach((s, i) => { H.sp[s] = order[(i + rd - 1) % order.length]; });
    }
    for (const s of slots) { H.lf[s] = 0; H.al[s] = 1; }
    this.alive = new Set(slots);
    this.respawnAt.clear();
    this.phaseLeft = COUNTDOWN;
    this.publishHost();
  }

  admitLateJoiners() {
    const H = this.H;
    const taken = new Set(this.allSlots());
    for (const p of this.humans(this.net.peers())) {
      if (H.sl[p.id] != null || taken.size >= MAX_TANKS) continue;
      let slot = 0;
      while (taken.has(slot)) slot++;
      taken.add(slot);
      H.sl[p.id] = slot;
      H.tm[slot] = this.settings.tm ? (p.state.t ? 1 : 0) : 0;
      const usedColors = new Set(Object.values(H.cl));
      H.cl[slot] = this.settings.tm ? TEAM_COLORS[H.tm[slot]] : (PALETTE.find((c) => !usedColors.has(c)) ?? PALETTE[slot % 8]);
      H.sc[slot] = H.sc[slot] ?? 0;
    }
  }

  hostDropPlayer(id) {
    const H = this.H;
    if (!H || H.sl[id] == null) return;
    const slot = H.sl[id];
    delete H.sl[id];
    this.alive.delete(slot);
    if (H.al) H.al[slot] = 0;
    this.publishHost();
  }

  sidesAlive() {
    const sides = new Set();
    for (const s of this.alive) sides.add(this.settings.tm ? (this.H.tm[s] ?? 0) : s);
    return sides;
  }

  hostTick(dt, peers) {
    const H = this.H;
    const st = this.settings;
    // lobby listing for the room transport
    this.advertiseT -= dt;
    if (this.advertiseT <= 0 && this.net.advertise) {
      this.advertiseT = 2;
      this.net.advertise({ code: this.code, name: `${sanitizeText(this.me.n, 16)}'s game`, n: this.humans(peers).length, ig: H.ph === 'lb' ? 0 : 1 });
    }
    if (H.ph === 'lb' || H.ph === 'rs') return;

    if (H.ph === 'cd') {
      if (this.phaseLeft <= 0) { H.ph = 'pl'; this.publishHost(); }
    } else if (H.ph === 'pl') {
      if (st.md === 0) {
        const sides = this.sidesAlive();
        if (sides.size <= 1) {
          const side = sides.size ? [...sides][0] : -1;
          H.wn = st.tm ? { s: -1, t: side } : { s: side, t: -1 };
          if (side >= 0) { if (st.tm) H.ts[side]++; else H.sc[side] = (H.sc[side] || 0) + 1; }
          H.ph = 'ro';
          this.phaseLeft = ROUND_OVER;
          this.publishHost();
        }
      } else {
        const now = performance.now();
        for (const [slot, at] of this.respawnAt) {
          if (now < at) continue;
          this.respawnAt.delete(slot);
          if (!this.allSlots().includes(slot)) continue;
          H.lf[slot] = (H.lf[slot] || 0) + 1;
          H.sp[slot] = this.safestSpawn(slot);
          H.al[slot] = 1;
          this.alive.add(slot);
          this.publishHost();
        }
        if (st.md === 1) this.admitDeathmatchJoiners();
      }
    } else if (H.ph === 'ro') {
      if (this.phaseLeft <= 0) {
        const best = st.tm ? Math.max(...H.ts) : Math.max(0, ...Object.values(H.sc));
        if (best >= st.rw) { H.ph = 'rs'; this.publishHost(); }
        else this.hostNewRound(H.rd + 1);
      }
    }

    // bots
    if (H.ph === 'pl' || H.ph === 'ro') for (const b of this.bots) b.ai.update(dt);
    else for (const b of this.bots) b.tank.drive(dt, null, 0);
    if (this.bots.length) {
      const now = Math.round(performance.now());
      this.net.setState({ B: this.bots.map((b) => [b.slot, r2(b.tank.x), r2(b.tank.z), r3(b.tank.hullYaw), r3(b.tank.turretYaw), r2(b.tank.speed), r2(b.tank.turnRate), b.tank.alive ? 1 : 0, now]) });
    }
    const T = Math.round(this.phaseLeft * 10);
    if (T !== this.lastT) { this.lastT = T; this.net.setState({ T }); }
  }

  admitDeathmatchJoiners() {
    const H = this.H;
    const before = Object.keys(H.sl).length;
    this.admitLateJoiners();
    if (Object.keys(H.sl).length === before) return;
    for (const slot of Object.values(H.sl)) {
      if (H.lf[slot] != null) continue;
      H.lf[slot] = 0; H.sp[slot] = this.safestSpawn(slot); H.al[slot] = 1;
      this.alive.add(slot);
    }
    this.publishHost();
  }

  safestSpawn(slot) {
    const spawns = this.spawns || this.game.world.multiSpawns();
    let best = 0, bestD = -1;
    spawns.forEach((sp, i) => {
      let d = Infinity;
      for (const t of this.game.tanks) if (t.alive && t.slot !== slot) d = Math.min(d, Math.hypot(t.x - sp.x, t.z - sp.z));
      if (d > bestD) { bestD = d; best = i; }
    });
    return best;
  }

  // Called by the game when the host's projectiles destroy a tank.
  onTankHit(tank, cause) {
    if (!this.isHost || this.H.ph === 'lb' || this.H.ph === 'rs') return;
    const slot = tank.slot;
    if (slot == null || !this.alive.has(slot)) return;
    const H = this.H, st = this.settings;
    this.alive.delete(slot);
    H.al[slot] = 0;
    const killer = cause.by && cause.by.slot != null ? cause.by.slot : -1;
    const code = cause.kind === 'mine' ? 2 : cause.bounced ? 1 : 0;
    const shot = cause.shot;
    this.pushEvent(['k', slot, killer, code, shot ? shot.owner.slot : -1, shot ? shot.id : 0]);
    this.destroyTank(tank);
    this.killFeed(slot, killer, code);
    if (st.md === 1 && H.ph === 'pl') {
      const enemy = killer >= 0 && killer !== slot && (!st.tm || H.tm[killer] !== H.tm[slot]);
      // individual kills always count for the scoreboard; teams also keep a team total
      if (enemy) { H.sc[killer] = (H.sc[killer] || 0) + 1; if (st.tm) H.ts[H.tm[killer] ?? 0]++; }
      else if (killer >= 0) { H.sc[killer] = Math.max(0, (H.sc[killer] || 0) - 1); if (st.tm) H.ts[H.tm[killer] ?? 0] = Math.max(0, H.ts[H.tm[killer] ?? 0] - 1); }
      const best = st.tm ? Math.max(...H.ts) : Math.max(0, ...Object.values(H.sc));
      if (best >= st.kl) { H.ph = 'rs'; }
      else this.respawnAt.set(slot, performance.now() + RESPAWN * 1000);
    }
    this.publishHost();
  }

  onShellGone(s, why) { if (this.isHost && this.inGame && s.owner.slot != null) this.pushEvent(['x', s.owner.slot, s.id, why === 'clash' ? 1 : 2]); }
  onDetonate(m) { if (this.isHost && this.inGame && m.owner.slot != null) this.pushEvent(['d', m.owner.slot, m.id, r2(m.x), r2(m.z)]); }

  hostBackToLobby() {
    if (!this.isHost) return;
    this.H.ph = 'lb';
    this.publishHost();
  }

  // ---------- results ----------
  standings() {
    const H = this.hostState()?.H;
    if (!H) return [];
    const rows = [];
    for (const s of [...Object.values(H.sl || {}), ...Object.keys(H.bo || {}).map(Number)]) {
      rows.push({ slot: s, name: this.nameOf(s), color: H.cl?.[s] ?? PALETTE[s % 8], score: H.sc?.[s] || 0, team: H.tm?.[s] ?? 0, me: s === this.mySlot, alive: H.al?.[s] !== 0 });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows;
  }

  teamScores() { return this.hostState()?.H?.ts || [0, 0]; }

  iWon() {
    const rows = this.standings();
    if (!rows.length || this.mySlot == null) return false;
    if (this.settings.tm) { const ts = this.teamScores(); return ts[this.teamOf(this.mySlot)] >= Math.max(...ts); }
    return rows[0].me;
  }

  resultTitle() {
    if (this.settings.tm) {
      const ts = this.teamScores();
      const w = ts[0] === ts[1] ? -1 : ts[0] > ts[1] ? 0 : 1;
      return { big: w < 0 ? 'DRAW' : `${TEAM_NAMES[w].toUpperCase()} TEAM WINS`, small: `${TEAM_NAMES[0]} ${ts[0]} : ${ts[1]} ${TEAM_NAMES[1]}` };
    }
    const rows = this.standings();
    const top = rows[0];
    return { big: top ? (top.me ? 'VICTORY' : `${top.name.toUpperCase()} WINS`) : 'MATCH OVER', small: this.settings.md ? 'Deathmatch' : 'Last tank standing' };
  }

  // ---------- HUD helpers ----------
  markerTargets() {
    const out = [];
    const st = this.settings;
    const mine = this.game.player;
    for (const t of this.tanks.values()) {
      if (t === mine || !t.alive) continue;
      const ally = !!st.tm && t.team === mine.team && this.hasSlot();
      if (!ally && st.mk === 0) continue;
      out.push({ tank: t, name: this.nameOf(t.slot), enemy: !ally, mode: ally ? 2 : st.mk, color: this.colorOf(t.slot) });
    }
    return out;
  }

  tally() {
    const rows = this.standings();
    const st = this.settings;
    const mine = rows.find((r) => r.me);
    if (st.tm) {
      // your team on the left
      const ts = this.teamScores();
      const mineTeam = this.mySlot != null ? this.teamOf(this.mySlot) : 0, other = 1 - mineTeam;
      return { you: ts[mineTeam], bot: ts[other], youLabel: TEAM_NAMES[mineTeam].toUpperCase(), botName: TEAM_NAMES[other].toUpperCase() };
    }
    const rival = rows.find((r) => !r.me);
    return { you: mine ? mine.score : 0, bot: rival ? rival.score : 0, youLabel: 'YOU', botName: rival ? rival.name.toUpperCase() : '—' };
  }

  // ---------- teardown ----------
  clearMatch() {
    const g = this.game;
    for (const [slot, t] of this.tanks) if (t !== g.player) g.scene.remove(t.root);
    this.tanks.clear();
    this.remote.clear();
    this.bots = [];
    this.round = 0; this.seed = 0;
    g.projectiles.clear();
    g.leaveMpMatch();
  }

  end(reason) {
    if (this.ended) return;
    this.ended = true;
    if (this.net.advertise) this.net.advertise(null);
    this.net.close();
    const g = this.game;
    for (const [, t] of this.tanks) if (t !== g.player) g.scene.remove(t.root);
    this.tanks.clear();
    g.endMp(reason);
  }
}
