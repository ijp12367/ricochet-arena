// HUD: score, ammo, crosshair, opponent markers, incoming-shell warnings, banners and feed.
import * as THREE from '../vendor/three/build/three.module.js';
import { wrapAngle, segPointDist2 } from './utils.js';
import { blocksSight } from './world.js';

const $ = (id) => document.getElementById(id);
const _v = new THREE.Vector3();
const hex = (c) => '#' + c.toString(16).padStart(6, '0');

export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'), you: $('score-you'), youLabel: $('you-label'), bot: $('score-bot'), botName: $('bot-name'), round: $('round-label'), mode: $('mode-label'),
      shells: $('shell-pips'), mines: $('mine-pips'), reload: $('reload-arc'), marks: $('marks'),
      threats: $('threats'), hull: $('hull-icon'),
      banner: $('banner'), bannerBig: $('banner-big'), bannerSmall: $('banner-small'), feed: $('feed'), fade: $('fade'),
      hint: $('hint'), cross: $('crosshair'), lives: $('lives'),
    };
    this.bannerT = 0;
    this.threatEls = [];
    this.markEls = [];
    this.arrowEls = [];
    this.pipCache = '';
    this.matchKey = '';
  }

  show(on) { this.el.hud.hidden = !on; }

  setMatch({ you, bot, round, botName, mode, lives, youLabel = 'YOU' }) {
    const key = [you, bot, round, botName, mode, lives, youLabel].join('|');
    if (key === this.matchKey) return;
    this.matchKey = key;
    this.el.you.textContent = you;
    this.el.bot.textContent = bot;
    this.el.round.textContent = round;
    this.el.botName.textContent = botName;
    this.el.mode.textContent = mode;
    this.el.youLabel.textContent = youLabel;
    if (lives != null) {
      this.el.lives.hidden = false;
      this.el.lives.innerHTML = Array.from({ length: 3 }, (_, i) => `<i class="${i < lives ? 'on' : ''}"></i>`).join('');
    } else this.el.lives.hidden = true;
  }

  banner(big, small = '', time = 2, tone = '') {
    const b = this.el.banner;
    this.el.bannerBig.textContent = big;
    this.el.bannerSmall.textContent = small;
    b.className = 'show ' + tone;
    // restart the entrance animation
    void b.offsetWidth;
    b.classList.add('pop');
    this.bannerT = time;
  }

  feed(text, tone = '') {
    const d = document.createElement('div');
    d.className = 'feed-line ' + tone;
    d.textContent = text;
    this.el.feed.prepend(d);
    setTimeout(() => d.classList.add('out'), 3800);
    setTimeout(() => d.remove(), 4400);
    while (this.el.feed.children.length > 4) this.el.feed.lastChild.remove();
  }

  fade(on) { this.el.fade.classList.toggle('on', on); }

  pool(list, n, make) {
    while (list.length < n) { const e = make(); this.el.marks.appendChild(e); list.push(e); }
    list.forEach((e, i) => { e.hidden = i >= n; });
  }

  update(dt, game) {
    if (this.bannerT > 0) { this.bannerT -= dt; if (this.bannerT <= 0) this.el.banner.className = ''; }
    const me = game.player, cam = game.camera;
    if (!me) return;

    // ammo pips
    const p = me.params;
    const key = `${p.maxShells - me.activeShells}/${p.maxShells}|${p.maxMines - me.activeMines}/${p.maxMines}`;
    if (key !== this.pipCache) {
      this.pipCache = key;
      const avail = p.maxShells - me.activeShells, mAvail = p.maxMines - me.activeMines;
      this.el.shells.innerHTML = Array.from({ length: p.maxShells }, (_, i) => `<i class="${i < avail ? 'on' : ''}"></i>`).join('');
      this.el.mines.innerHTML = Array.from({ length: p.maxMines }, (_, i) => `<i class="${i < mAvail ? 'on' : ''}"></i>`).join('');
    }
    const cd = Math.max(0, me.cooldown) / p.cooldown;
    this.el.reload.style.strokeDashoffset = String(cd * 100);
    this.el.cross.classList.toggle('empty', me.activeShells >= p.maxShells);

    // hull direction relative to the view
    const camYaw = game.viewYaw;
    const rel = wrapAngle(me.hullYaw - camYaw);
    this.el.hull.style.transform = `rotate(${(-rel * 180) / Math.PI}deg)`;

    // opponent markers: on-screen pins, off-screen arrows
    const targets = game.state === 'menu' ? [] : game.markerTargets();
    const pins = [], arrows = [];
    for (const t of targets) {
      const tk = t.tank;
      const seen = game.world.lineClear(cam.position.x, cam.position.z, tk.x, tk.z, blocksSight);
      if (t.mode === 1 && !seen) continue;
      _v.set(tk.x, tk.height + 0.75, tk.z).project(cam);
      const onScreen = _v.z < 1 && Math.abs(_v.x) < 0.95 && Math.abs(_v.y) < 0.92;
      if (onScreen) pins.push({ t, seen, sx: (_v.x * 0.5 + 0.5) * innerWidth, sy: (-_v.y * 0.5 + 0.5) * innerHeight, d: Math.hypot(tk.x - me.x, tk.z - me.z) });
      else if (t.enemy) arrows.push({ t, bearing: wrapAngle(Math.atan2(tk.x - me.x, tk.z - me.z) - camYaw), d: Math.hypot(tk.x - me.x, tk.z - me.z) });
    }
    arrows.sort((a, b) => a.d - b.d).splice(4);
    this.pool(this.markEls, pins.length, () => {
      const m = document.createElement('div');
      m.className = 'tmark';
      m.innerHTML = '<div class="inner"><span class="nm"></span><i class="pin"></i></div>';
      return m;
    });
    pins.forEach((pin, i) => {
      const m = this.markEls[i];
      m.style.transform = `translate(${pin.sx}px, ${pin.sy}px)`;
      m.classList.toggle('occluded', !pin.seen);
      m.classList.toggle('ally', !pin.t.enemy);
      m.style.setProperty('--mc', pin.t.enemy ? (pin.t.color != null && game.mp ? hex(pin.t.color) : 'var(--enemy)') : 'var(--ally)');
      const label = (pin.t.name ? pin.t.name + ' · ' : '') + Math.round(pin.d) + ' m';
      const nm = m.firstChild.firstChild;
      if (nm.textContent !== label) nm.textContent = label;
    });
    this.pool(this.arrowEls, arrows.length, () => {
      const a = document.createElement('div');
      a.className = 'tarrow';
      a.innerHTML = '<i></i>';
      return a;
    });
    arrows.forEach((ar, i) => {
      const a = this.arrowEls[i];
      a.style.transform = `rotate(${(-ar.bearing * 180) / Math.PI}deg)`;
      a.style.setProperty('--mc', ar.t.color != null && game.mp ? hex(ar.t.color) : 'var(--enemy)');
    });

    // incoming shells
    const threats = [];
    if (me.alive && game.threatWarnings()) {
      for (const s of game.projectiles.shells) {
        if (!s.alive || (s.owner === me && s.bounces === s.startBounces)) continue;
        const pts = game.world.tracePath(s.x, s.z, s.dx, s.dz, s.bounces, s.speed * 1.4, s.r, 0.2);
        for (let i = 1; i < pts.length; i++) {
          const { d2 } = segPointDist2(pts[i - 1].x, pts[i - 1].z, pts[i].x, pts[i].z, me.x, me.z);
          if (d2 < 1.6 * 1.6) { threats.push(wrapAngle(Math.atan2(s.x - me.x, s.z - me.z) - camYaw)); break; }
        }
      }
    }
    while (this.threatEls.length < threats.length) {
      const t = document.createElement('div');
      t.className = 'threat';
      this.el.threats.appendChild(t);
      this.threatEls.push(t);
    }
    this.threatEls.forEach((t, i) => {
      if (i < threats.length) { t.hidden = false; t.style.transform = `rotate(${(-threats[i] * 180) / Math.PI}deg)`; }
      else t.hidden = true;
    });
  }
}
