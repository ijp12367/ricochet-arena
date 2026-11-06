// Game bootstrap, rendering, round flow and player control.
import * as THREE from '../vendor/three/build/three.module.js';
import { EffectComposer } from '../vendor/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/three/examples/jsm/postprocessing/OutputPass.js';
import { assets, loadAssets } from './assets.js';
import { World, blocksSight } from './world.js';
import { Tank } from './tank.js';
import { Projectiles } from './projectiles.js';
import { Bot } from './ai.js';
import { Effects } from './effects.js';
import { AudioEngine } from './audio.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { MpSession } from './mp.js';
import { MpUi } from './mpui.js';
import { PLAYER, BOTS, gauntletBot, DUEL_TARGET, GAUNTLET_LIVES, SIZES, SHELL_Y, SHELL_RADIUS } from './config.js';
import { clamp, wrapAngle, store, lerp } from './utils.js';

const DEFAULTS = { sensitivity: 1, volume: 0.8, controls: 'arcade', aimLine: true, quality: 'high', invertY: false, fov: 74 };
const QUALITY = {
  high: { ratio: 2, shadow: 4096, bloom: true, msaa: 4 },
  medium: { ratio: 1.25, shadow: 2048, bloom: true, msaa: 2 },
  low: { ratio: 1, shadow: 1024, bloom: false, msaa: 0 },
};
const DIFF_TEXT = {
  recruit: 'Slow, aims straight at you, never banks a shot.',
  regular: 'Plans single-bounce shots and sometimes dodges.',
  veteran: 'Two-bounce shells, mines, shoots your shells down.',
  ace: 'Fast shells, quick reflexes, relentless.',
};
const MODE_TEXT = {
  duel: `One bot, a fresh random arena every round. First to ${DUEL_TARGET} wins.`,
  gauntlet: 'Each level brings a tougher bot. You have three lives.',
};
const $ = (id) => document.getElementById(id);
const _dir = new THREE.Vector3();

class Game {
  constructor(hot) {
    this.settings = { ...DEFAULTS, ...store.get('ricochet-settings', {}), ...(hot.settings || {}) };
    this.best = store.get('ricochet-best', 0);
    this.mode = 'duel';
    this.diff = store.get('ricochet-diff', 'regular');
    this.menuMode = store.get('ricochet-mode', 'duel');
    this.arenaSize = store.get('ricochet-size', 'medium');
    if (!SIZES[this.arenaSize]) this.arenaSize = 'medium';
    this.state = 'loading';
    this.timeScale = 1; this.slowmoT = 0;
    this.lookYaw = 0; this.lookPitch = 0; this.viewYaw = 0;
    this.firing = false; this.paused = false;
    this.orbit = 0; this.bobT = 0;
    this.botCache = new Map();
    this.mp = null;
  }

  async init() {
    this.setupRenderer();
    this.audio = new AudioEngine();
    this.input = new Input(this.canvas);
    this.hud = new Hud();
    const bar = $('load-bar');
    let pa = 0, pb = 0;
    const prog = () => { bar.style.transform = `scaleX(${(pa * 0.85 + pb * 0.15).toFixed(3)})`; };
    try {
      await Promise.all([
        loadAssets(this.renderer, (v) => { pa = v; prog(); }),
        this.audio.load((v) => { pb = v; prog(); }),
      ]);
    } catch (err) {
      $('load-status').textContent = `${err.message}. Reload the page to try again.`;
      return;
    }
    this.setupScene();
    this.world = new World(this.scene);
    this.effects = new Effects(this.scene, this.world.materials);
    this.projectiles = new Projectiles(this);
    this.player = new Tank({ model: 'olive', paint: null, params: PLAYER, isPlayer: true, label: 'YOU' });
    this.scene.add(this.player.root);
    this.tanks = [this.player];
    this.aimDots = this.makeAimDots();
    this.applySettings();
    this.bindUI();
    this.mpUi = new MpUi(this);
    this.startAttract();
    this.renderer.compile(this.scene, this.camera);
    $('loading').hidden = true;
    $('menu').hidden = false;
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.frame());
    this.mpUi.checkInvite();
  }

  // ---------- rendering ----------
  setupRenderer() {
    this.canvas = $('view');
    const r = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.setSize(innerWidth, innerHeight);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, innerWidth / innerHeight, 0.05, 420);
    this.scene.add(this.camera);
    addEventListener('resize', () => this.resize());
  }

  buildComposer() {
    const q = QUALITY[this.settings.quality] || QUALITY.high;
    if (this.composer) this.composer.dispose();
    const ratio = this.renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(innerWidth * ratio, innerHeight * ratio, { type: THREE.HalfFloatType, samples: q.msaa });
    const c = this.composer = new EffectComposer(this.renderer, rt);
    c.addPass(new RenderPass(this.scene, this.camera));
    if (q.bloom) c.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.45, 1.05));
    c.addPass(new OutputPass());
    c.setPixelRatio(ratio);
    c.setSize(innerWidth, innerHeight);
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    if (this.composer) this.composer.setSize(innerWidth, innerHeight);
  }

  setupScene() {
    const s = this.scene;
    s.background = assets.background;
    s.environment = assets.envMap;
    s.fog = new THREE.Fog(0xbfc7cc, 80, 260);
    const sun = this.sun = new THREE.DirectionalLight(0xfff0dc, 3.3);
    const d = assets.sunDir.clone();
    d.y = clamp(d.y, 0.42, 0.78);  // keep shadows long enough to read the terrain
    d.normalize();
    sun.position.copy(d).multiplyScalar(70);
    sun.castShadow = true;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.035;
    s.add(sun, sun.target);
    s.add(new THREE.HemisphereLight(0xdde6ee, 0x6e5c46, 0.3));
  }

  applySettings() {
    const s = this.settings, q = QUALITY[s.quality] || QUALITY.high;
    this.audio.setVolume(s.volume);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, q.ratio));
    this.renderer.setSize(innerWidth, innerHeight);
    if (this.sun && this.sun.shadow.mapSize.x !== q.shadow) {
      this.sun.shadow.mapSize.set(q.shadow, q.shadow);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    }
    this.buildComposer();
    store.set('ricochet-settings', s);
  }

  makeAimDots() {
    const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.03, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }), 96);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(96 * 3), 3);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.renderOrder = 4;
    this.scene.add(mesh);
    return mesh;
  }

  // ---------- arenas, tanks and rounds ----------
  // Resize the arena and keep the sun's shadow box covering all of it.
  useSize(key) {
    const sz = SIZES[key] || SIZES.medium;
    this.world.setSize(sz.w, sz.h);
    const R = Math.hypot(this.world.HW * 2, this.world.HH * 2) / 2 + 3;
    const cam = this.sun.shadow.camera;
    if (cam.right !== R) {
      Object.assign(cam, { left: -R, right: R, top: R, bottom: -R, near: 20, far: 140 });
      cam.updateProjectionMatrix();
    }
  }

  newArena() {
    this.useSize(this.arenaSize);
    this.effects.clear();
    this.projectiles.clear();
    this.spawns = this.world.generate((Math.random() * 2 ** 31) | 0);
    this.world.build();
  }

  setupBot(params) {
    const key = params.model + ':' + params.paint;
    if (this.bot) this.scene.remove(this.bot.tank.root);
    let tank = this.botCache.get(key);
    if (!tank) {
      tank = new Tank({ model: params.model, paint: params.paint, params, isPlayer: false, label: params.name });
      this.botCache.set(key, tank);
    }
    tank.params = params;
    this.scene.add(tank.root);
    this.bot = new Bot(this, tank, this.player);
    this.tanks = [this.player, tank];
  }

  startAttract() {
    this.state = 'menu';
    this.input.enabled = false;
    this.firing = true;
    this.paused = false;
    this.pendingEnd = null;
    this.timeScale = 1; this.slowmoT = 0;
    this.hud.show(false);
    this.audio.setVolume(this.settings.volume * 0.25);
    this.player.params = { ...BOTS.regular, maxShells: 3, cooldown: 0.9 };
    this.setupBot(BOTS.regular);
    this.playerBot = new Bot(this, this.player, this.bot.tank);
    this.resetAttract();
  }

  resetAttract() {
    this.newArena();
    const sp = this.spawns;
    this.player.reset(sp.player.x, sp.player.z, sp.player.yaw);
    this.bot.tank.reset(sp.bot.x, sp.bot.z, sp.bot.yaw);
    this.bot.reset(); this.playerBot.reset();
    this.attractT = 0;
  }

  startMatch(mode, diff) {
    this.mode = mode; this.diff = diff;
    this.score = { you: 0, bot: 0 };
    this.round = 0; this.level = 1; this.lives = GAUNTLET_LIVES;
    this.stats = { shots: 0, bounceKills: 0, mineKills: 0, rounds: 0 };
    this.playerBot = null;
    this.player.params = PLAYER;
    this.audio.setVolume(this.settings.volume);
    $('menu').hidden = true;
    $('results').hidden = true;
    this.hud.show(true);
    this.input.enabled = true;
    document.body.classList.add('playing');
    this.beginRound();
  }

  beginRound() {
    this.round++;
    this.state = 'transition';
    this.firing = false;
    this.pendingEnd = null;
    this.hud.fade(true);
    setTimeout(() => {
      const params = this.mode === 'duel' ? BOTS[this.diff] : gauntletBot(this.level);
      this.newArena();
      this.setupBot(params);
      const sp = this.spawns;
      this.player.reset(sp.player.x, sp.player.z, sp.player.yaw);
      this.bot.tank.reset(sp.bot.x, sp.bot.z, sp.bot.yaw);
      this.bot.reset();
      this.lookYaw = sp.player.yaw; this.lookPitch = -0.04;
      this.deathCam = null;
      this.timeScale = 1; this.slowmoT = 0;
      this.updateMatchHud();
      this.hud.fade(false);
      this.state = 'countdown';
      this.countdown = 3.4;
      this.lastCount = 9;
      this.startEngines();
      this.hud.banner(this.mode === 'duel' ? `ROUND ${this.round}` : `LEVEL ${this.level}`, `${params.name} TANK`, 1.1);
      this.audio.play('round_start', { volume: 0.5 });
    }, 420);
  }

  updateMatchHud() {
    const botName = this.bot.tank.params.name;
    if (this.mode === 'duel') {
      this.hud.setMatch({ you: this.score.you, bot: this.score.bot, round: `ROUND ${this.round}`, botName,
        mode: `DUEL · ${this.diff.toUpperCase()} · FIRST TO ${DUEL_TARGET}` });
    } else {
      this.hud.setMatch({ you: this.level - 1, bot: GAUNTLET_LIVES - this.lives, round: `LEVEL ${this.level}`, botName,
        mode: `GAUNTLET · BEST LEVEL ${Math.max(this.best, this.level)}`, lives: this.lives });
    }
  }

  startEngines() {
    if (!this.playerEngine) this.playerEngine = this.audio.engine(false);
    if (!this.botEngine) this.botEngine = this.audio.engine(true);
  }

  // ---------- multiplayer lifecycle ----------
  startMp(net, opts) {
    const mp = this.mp = new MpSession(this, net, opts);
    const pr = this.projectiles;
    pr.onFire = (t, s) => this.mp && this.mp.onFire(t, s);
    pr.onMineLaid = (t, m) => this.mp && this.mp.onMine(t, m);
    pr.onShellGone = (s, why) => this.mp && this.mp.onShellGone(s, why);
    pr.onDetonate = (m) => this.mp && this.mp.onDetonate(m);
    this.mpUi.clearChat();
    mp.system(opts.isHost ? `Lobby ${opts.code} is open. Share the code with your friends.` : `Joining lobby ${opts.code}…`);
    document.body.classList.add('in-mp');
    this.backgroundTicker(true);
  }

  // First round of a match: leave the attract scene and drop into first person.
  enterMpMatch() {
    if (this.bot) this.scene.remove(this.bot.tank.root);
    this.bot = null;
    this.playerBot = null;
    this.state = 'mp';
    this.projectiles.authoritative = this.mp.isHost;   // only the host decides hits
    this.paused = false;
    this.timeScale = 1; this.slowmoT = 0;
    this.audio.setVolume(this.settings.volume);
    $('menu').hidden = true;
    this.mpUi.hideAll();
    this.mpUi.setInGame(true);
    this.hud.show(true);
    this.hud.matchKey = '';
    this.input.enabled = true;
    document.body.classList.add('playing');
    this.startEngines();
    $('hint').classList.add('show');
    setTimeout(() => $('hint').classList.remove('show'), 9000);
  }

  // Host went back to the lobby: show the attract scene behind the lobby screen again.
  leaveMpMatch() {
    $('pause').hidden = true;
    this.projectiles.authoritative = true;   // the attract scene behind the lobby is local
    this.input.releaseLock();
    this.input.enabled = false;
    document.body.classList.remove('playing');
    this.mpUi.setInGame(false);
    this.hud.show(false);
    this.player.root.visible = true;
    this.player.restorePaint();
    this.audio.updateEngine(this.playerEngine, 0, 0, 0, false);
    this.startAttract();
  }

  endMp(reason) {
    const pr = this.projectiles;
    pr.authoritative = true;
    pr.onFire = pr.onMineLaid = pr.onShellGone = pr.onDetonate = null;
    this.mp = null;
    this.backgroundTicker(false);
    document.body.classList.remove('in-mp');
    this.mpUi.hideAll();
    this.mpUi.setInGame(false);
    this.player.root.visible = true;
    this.player.restorePaint();
    this.quitToMenu();
    const toast = $('menu-toast');
    toast.textContent = reason || '';
    toast.hidden = !reason;
    if (reason) setTimeout(() => { toast.hidden = true; }, 8000);
  }

  canDamage(a, b) { return this.mp ? this.mp.canDamage(a, b) : true; }

  markerTargets() {
    if (this.mp) return this.mp.markerTargets();
    return this.bot && this.bot.tank.alive ? [{ tank: this.bot.tank, name: '', enemy: true, mode: 2 }] : [];
  }

  threatWarnings() { return this.mp ? !!this.mp.settings.tw : true; }

  updateMp(dt, real) {
    const mp = this.mp;
    mp.update(dt);
    if (this.state !== 'mp' || !this.mp) return;
    this.updatePlayer(dt);
    for (const t of this.tanks) {
      if (t.alive && !t.remote) t.integrate(dt, this.world, this.tanks, this.effects);
      else if (!t.alive && (t.smokeT = (t.smokeT ?? 0) - dt) <= 0) { t.smokeT = 0.09; this.effects.wreckSmoke(t.x, t.z); }
      t.update(dt);
    }
    if (this.player.bumped) this.audio.play('tank_bump', { volume: 0.35 });
    this.projectiles.update(dt);
    this.effects.update(dt);
    this.updateSpectate(real);
    this.updateCamera(dt, real);
    this.updateAimDots();
    const ta = mp.tally();
    const ffa = !mp.settings.tm;
    this.hud.setMatch({ you: ta.you, bot: ta.bot, youLabel: ta.youLabel, botName: ta.botName, ffa,
      round: mp.settings.md ? 'DEATHMATCH' : `ROUND ${mp.round}`,
      mode: mp.settings.md ? `FIRST TO ${mp.settings.kl} KILLS` : `FIRST TO ${mp.settings.rw} ROUNDS` });
    // everyone's score: free-for-all, and team deathmatch where individual kills count
    this.hud.setBoard(ffa || mp.settings.md ? mp.standings() : null, mp.settings.md ? 'kills' : 'rounds');
    this.hud.update(real, this);
    this.mpUi.update(real);
    const cam = this.camera;
    cam.getWorldDirection(_dir);
    this.audio.setListener(cam.position, _dir);
    this.audio.updateEngine(this.playerEngine, Math.abs(this.player.speed) / PLAYER.speed + Math.abs(this.player.turnRate) * 0.08, this.player.x, this.player.z, mp.hasSlot() && this.player.alive);
  }

  tankHit(tank, cause) {
    if (this.mp && this.state === 'mp') { this.mp.onTankHit(tank, cause); return; }
    if (!tank.alive) return;
    tank.wreck();
    tank.cause = cause;
    tank.smokeT = 0;
    this.effects.explosion(tank.x, tank.z, 1.3, 0.75);
    this.effects.tankBurst(tank.x, tank.z);
    this.audio.boom(tank.x, 0.8, tank.z, 1.25);
    this.shakeFrom(tank.x, tank.z, 1.1);
    if (this.state === 'menu') { this.attractT = 3.2; return; }
    if (this.state !== 'playing' && this.state !== 'countdown') return;
    if (!this.pendingEnd) this.pendingEnd = { t: 0.12 };
  }

  describe(victim, cause) {
    const self = cause.by === victim;
    if (victim === this.player) {
      if (cause.kind === 'mine') return self ? 'Your own mine caught you' : 'Caught in a mine blast';
      if (self) return 'Your own shell came back for you';
      return cause.bounced ? 'Hit by a ricochet' : 'Direct hit';
    }
    if (cause.kind === 'mine') return self ? 'The bot drove into its own blast' : 'Mine kill';
    if (self) return 'The bot shot itself';
    return cause.bounced ? 'Ricochet kill' : 'Direct hit';
  }

  resolveRound() {
    this.pendingEnd = null;
    const pAlive = this.player.alive, bAlive = this.bot.tank.alive;
    this.state = 'roundOver';
    this.firing = false;
    this.stats.rounds++;
    if (pAlive && !bAlive) {
      const why = this.describe(this.bot.tank, this.bot.tank.cause);
      if (this.bot.tank.cause.by === this.player && this.bot.tank.cause.bounced) this.stats.bounceKills++;
      if (this.bot.tank.cause.kind === 'mine' && this.bot.tank.cause.by === this.player) this.stats.mineKills++;
      this.hud.banner('TARGET DESTROYED', why, 2.6, 'win');
      this.hud.feed(why, 'win');
      this.audio.play('win', { volume: 0.7 });
      this.slowmoT = 1.1;
      if (this.mode === 'duel') this.score.you++; else { this.level++; this.best = Math.max(this.best, this.level - 1); store.set('ricochet-best', this.best); }
    } else if (!pAlive && bAlive) {
      const why = this.describe(this.player, this.player.cause);
      this.hud.banner('TANK DESTROYED', why, 2.6, 'loss');
      this.hud.feed(why, 'loss');
      this.audio.play('lose', { volume: 0.7 });
      if (this.mode === 'duel') this.score.bot++; else this.lives--;
    } else {
      this.hud.banner('DOUBLE KNOCKOUT', 'Nobody scores this round', 2.6);
      if (this.mode === 'gauntlet') this.lives--;
    }
    this.updateMatchHud();
    this.roundOverT = 3.3;
  }

  matchOver() {
    if (this.mode === 'duel') return this.score.you >= DUEL_TARGET || this.score.bot >= DUEL_TARGET;
    return this.lives <= 0;
  }

  showResults() {
    this.state = 'results';
    this.input.releaseLock();
    this.input.enabled = false;
    document.body.classList.remove('playing');
    this.hud.show(false);
    let title, sub;
    if (this.mode === 'duel') {
      const won = this.score.you > this.score.bot;
      title = won ? 'VICTORY' : 'DEFEAT';
      sub = `${this.score.you} : ${this.score.bot} against the ${BOTS[this.diff].name.toLowerCase()} bot`;
    } else {
      title = 'GAUNTLET OVER';
      sub = `You cleared ${this.level - 1} level${this.level === 2 ? '' : 's'}. Best: ${this.best}.`;
    }
    $('results-title').textContent = title;
    $('results-sub').textContent = sub;
    $('results-stats').innerHTML = [
      ['Rounds', this.stats.rounds], ['Shells fired', this.stats.shots],
      ['Ricochet kills', this.stats.bounceKills], ['Mine kills', this.stats.mineKills],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    $('results').hidden = false;
    this.audio.updateEngine(this.playerEngine, 0, 0, 0, false);
    this.audio.updateEngine(this.botEngine, 0, 0, 0, false);
  }

  shakeFrom(x, z, amount) {
    const d = Math.hypot(x - this.camera.position.x, z - this.camera.position.z);
    this.effects.shake(amount * clamp(1.4 - d / 18, 0, 1));
  }

  // ---------- frame ----------
  frame(background = false) {
    if (!background) this.lastRaf = performance.now();
    const raw = Math.min(this.clock.getDelta(), 1 / 20);
    if (!this.paused) {
      if (this.slowmoT > 0) { this.slowmoT -= raw; this.timeScale = this.slowmoT > 0.25 ? 0.3 : lerp(1, 0.3, this.slowmoT / 0.25); }
      else this.timeScale = 1;
      this.update(raw * this.timeScale, raw);
    }
    if (!background) this.composer.render();
    this.input.endFrame();
  }

  // Hidden, minimised or covered windows can stop getting animation frames (some even while
  // reporting themselves visible). During multiplayer a worker ticks at 30 Hz and steps the
  // match without drawing whenever frames stall, so a host who looks away doesn't freeze everyone.
  backgroundTicker(on) {
    if (!this.ticker) {
      try {
        const src = 'let t=null;onmessage=(e)=>{clearInterval(t);if(e.data)t=setInterval(()=>postMessage(0),33);};';
        this.ticker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        this.ticker.onmessage = () => { if (this.mp && performance.now() - (this.lastRaf || 0) > 120) this.frame(true); };
      } catch { this.ticker = null; return; }
    }
    this.ticker.postMessage(on ? 1 : 0);
  }

  update(dt, real) {
    const st = this.state;
    if (st === 'mp') { this.updateMp(dt, real); return; }
    if (st === 'menu') {
      this.playerBot.update(dt);
      this.bot.update(dt);
      if (this.attractT > 0) { this.attractT -= dt; if (this.attractT <= 0) this.resetAttract(); }
      if (this.mp) { this.mp.update(dt); this.mpUi.update(real); if (this.state !== 'menu') return; }
    } else if (st !== 'results') {
      if (st === 'countdown') this.tickCountdown(dt);
      this.updatePlayer(dt);
      if (st === 'playing' || st === 'roundOver') this.bot.update(dt);
      else if (st === 'countdown') {
        const b = this.bot.tank;
        b.aimToward(dt, Math.atan2(this.player.x - b.x, this.player.z - b.z), b.params.turretTurn * 0.5);
        b.drive(dt, null, 0);
      }
      if (this.pendingEnd && (this.pendingEnd.t -= dt) <= 0) this.resolveRound();
      if (st === 'roundOver' && (this.roundOverT -= real) <= 0) {
        if (this.matchOver()) this.showResults(); else this.beginRound();
      }
    }

    for (const t of this.tanks) {
      if (t.alive) t.integrate(dt, this.world, this.tanks, this.effects);
      else if ((t.smokeT -= dt) <= 0) { t.smokeT = 0.09; this.effects.wreckSmoke(t.x, t.z); }
      t.update(dt);
    }
    if (this.player.bumped && st !== 'menu') this.audio.play('tank_bump', { volume: 0.35 });
    this.projectiles.update(dt);
    this.effects.update(dt);
    this.updateCamera(dt, real);
    this.updateAimDots();
    if (st !== 'menu') this.hud.update(real, this);

    const cam = this.camera;
    cam.getWorldDirection(_dir);
    this.audio.setListener(cam.position, _dir);
    const inMatch = st === 'countdown' || st === 'playing' || st === 'roundOver';
    this.audio.updateEngine(this.playerEngine, Math.abs(this.player.speed) / PLAYER.speed + Math.abs(this.player.turnRate) * 0.08, this.player.x, this.player.z, inMatch && this.player.alive);
    if (this.bot) this.audio.updateEngine(this.botEngine, Math.abs(this.bot.tank.speed) / 4, this.bot.tank.x, this.bot.tank.z, inMatch && this.bot.tank.alive);
  }

  tickCountdown(dt) {
    this.countdown -= dt;
    const n = Math.ceil(this.countdown / 0.75);
    if (this.countdown <= 2.25 && n !== this.lastCount && n >= 1) {
      this.lastCount = n;
      this.hud.banner(String(n), '', 0.7, 'count');
      this.audio.play('countdown', { volume: 0.6, rate: 1 });
    }
    if (this.countdown <= 0) {
      this.state = 'playing';
      this.firing = true;
      this.hud.banner('FIGHT', '', 0.8, 'count');
      this.audio.play('countdown', { volume: 0.8, rate: 1.5 });
    }
  }

  updatePlayer(dt) {
    const me = this.player, inp = this.input, s = this.settings;
    if (!me.alive) return;
    // 1:1 mouse aim: every pixel of movement turns the turret by the same angle, no smoothing
    const sens = 0.0021 * s.sensitivity;
    if (!inp.touch.on) {
      this.lookYaw -= inp.dx * sens;
      this.lookPitch -= inp.dy * sens * (s.invertY ? -1 : 1);
      // uncaptured cursor pinned against the window edge: keep turning so you never run out of room
      if (!inp.locked && inp.cursor.inside) {
        if (inp.cursor.x < 0.012) this.lookYaw += 2.0 * s.sensitivity * dt;
        else if (inp.cursor.x > 0.988) this.lookYaw -= 2.0 * s.sensitivity * dt;
      }
    }
    if (inp.key('ArrowLeft')) this.lookYaw += 2.3 * dt;
    if (inp.key('ArrowRight')) this.lookYaw -= 2.3 * dt;
    if (inp.touch.aim) { this.lookYaw -= inp.touch.aim * 0.0055 * s.sensitivity; inp.touch.aim = 0; }
    this.lookPitch = clamp(this.lookPitch, -0.34, 0.22);
    this.lookYaw = wrapAngle(this.lookYaw);
    me.turretYaw = this.lookYaw;

    const typing = this.mpUi && this.mpUi.chatting;
    const drive = !typing && (this.mp ? this.mp.canDrive() : (this.state === 'playing' || this.state === 'roundOver'));
    const k = (c) => (inp.key(c) ? 1 : 0);
    if (!drive) me.drive(dt, null, 0);
    else if (s.controls === 'classic' && !inp.touch.on) {
      me.driveClassic(dt, k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown'), k('KeyA') - k('KeyD'));
    } else {
      let f = clamp(k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown'), -1, 1), r = k('KeyD') - k('KeyA');
      if (inp.touch.on && (inp.touch.mx || inp.touch.mz)) { f = inp.touch.mz; r = inp.touch.mx; }
      const yaw = this.lookYaw;
      const mx = f * Math.sin(yaw) - r * Math.cos(yaw), mz = f * Math.cos(yaw) + r * Math.sin(yaw);
      const len = Math.hypot(mx, mz);
      me.drive(dt, len > 0.05 ? Math.atan2(mx, mz) : null, Math.min(1, len));
    }

    const canFire = !typing && (this.mp ? this.mp.canFire() : (this.state === 'playing' && this.firing));
    if (canFire) {
      if (inp.firePressed || inp.hit('KeyF')) {
        if (this.projectiles.fire(me)) { if (this.stats && !this.mp) this.stats.shots++; }
        else if (me.activeShells >= me.params.maxShells) this.audio.play('ui_click', { volume: 0.4, rate: 0.7 });
      }
      if (inp.minePressed || inp.hit('Space') || inp.hit('KeyE')) this.projectiles.layMine(me);
    }
    if (!typing && inp.hit('KeyT')) {
      s.aimLine = !s.aimLine;
      $('set-aim').checked = s.aimLine;
      store.set('ricochet-settings', s);
      this.hud.feed(s.aimLine ? 'Aim line on' : 'Aim line off');
    }
  }

  // After dying in a last-tank-standing round (or while waiting to join), follow living players.
  // Click, Space, E or the right arrow cycles forward; Q or the left arrow goes back.
  updateSpectate(real) {
    const mp = this.mp, me = this.player, inp = this.input;
    const waiting = mp.inGame && !mp.hasSlot();
    const outOfRound = mp.inGame && mp.hasSlot() && !me.alive && !mp.settings.md;
    if (me.alive && mp.hasSlot()) this.deadFor = 0;
    else this.deadFor = (this.deadFor || 0) + real;
    let target = null;
    if ((waiting || outOfRound) && (waiting || this.deadFor > 2.2)) {
      const live = [...mp.tanks.entries()].filter(([, t]) => t.alive && t !== me).sort((a, b) => a[0] - b[0]);
      const cur = this.spectating && mp.tanks.get(this.spectating.slot);
      // stay on someone who just died for a moment, so you see what happened
      if (cur && !cur.alive && (this.spectating.lost = (this.spectating.lost || 0) + real) < 1.6) target = this.spectating.slot;
      else if (live.length) {
        let i = live.findIndex(([s]) => this.spectating && s === this.spectating.slot);
        const typing = this.mpUi.chatting;
        if (i < 0) i = 0;
        else if (!typing && (inp.firePressed || inp.hit('Space') || inp.hit('KeyE') || inp.hit('ArrowRight'))) i = (i + 1) % live.length;
        else if (!typing && (inp.hit('KeyQ') || inp.hit('ArrowLeft'))) i = (i - 1 + live.length) % live.length;
        target = live[i][0];
      }
    }
    if (target == null) this.spectating = null;
    else if (!this.spectating || this.spectating.slot !== target) this.spectating = { slot: target, lost: 0 };
    const label = this.spectating ? mp.nameOf(this.spectating.slot) : null;
    this.hud.setSpectate(label, waiting ? 'You join at the next round' : 'Click or Space for the next player');
  }

  updateCamera(dt, real) {
    const cam = this.camera, me = this.player, st = this.state;
    let fov = this.settings.fov;
    const follow = st === 'mp' && this.spectating && this.mp && this.mp.tanks.get(this.spectating.slot);
    const waiting = st === 'mp' && this.mp && !this.mp.hasSlot();
    if (follow) {
      // chase camera behind the followed tank's turret, pulled in front of any wall in the way
      const t = follow, yaw = t.turretYaw;
      let back = 6.4;
      for (let d = 0.5; d <= back; d += 0.25) {
        if (blocksSight(this.world.cellAtWorld(t.x - Math.sin(yaw) * d, t.z - Math.cos(yaw) * d))) { back = Math.max(1.2, d - 0.6); break; }
      }
      const { HW, HH } = this.world;
      const tx = clamp(t.x - Math.sin(yaw) * back, -HW + 0.6, HW - 0.6), tz = clamp(t.z - Math.cos(yaw) * back, -HH + 0.6, HH - 0.6);
      _dir.set(tx, back < 3 ? 4.6 : 3.3, tz);
      const k = 1 - Math.exp(-real * 6);
      if (cam.position.distanceTo(_dir) > 25) cam.position.copy(_dir); else cam.position.lerp(_dir, k);
      cam.lookAt(t.x + Math.sin(yaw) * 5, 0.8, t.z + Math.cos(yaw) * 5);
      fov = 64;
      this.deathCam = null;
    } else if (st === 'menu' || st === 'results' || (st === 'transition' && this.round === 0) || waiting) {
      this.orbit += real * 0.045;
      const R = Math.max(30, this.world.HW * 1.45);
      cam.position.set(Math.sin(this.orbit) * R, 15.5, Math.cos(this.orbit) * R * 0.78);
      cam.lookAt(Math.sin(this.orbit + 1.2) * 3, 0, 0);
      fov = 55;
    } else if (me.alive) {
      const c = me.turretCenter(), yaw = this.lookYaw, back = 0.34;
      cam.position.set(c.x - Math.sin(yaw) * back, me.turretTop + 0.36, c.z - Math.cos(yaw) * back);
      // the camera rides the hull suspension: project hull pitch/roll onto the turret's facing
      const rel = yaw - me.hullYaw, cr = Math.cos(rel), sr = Math.sin(rel);
      const pitch = me.pitch * cr + me.roll * sr;
      const roll = me.pitch * sr - me.roll * cr;
      // faint engine rumble, stronger under load
      this.bobT += real;
      const load = Math.min(1, Math.abs(me.speed) / me.params.speed + Math.abs(me.turnRate) * 0.2);
      cam.position.y += (Math.sin(this.bobT * 53) * 0.6 + Math.sin(this.bobT * 31) * 0.4) * 0.0012 * (0.25 + load);
      cam.rotation.set(this.lookPitch + pitch + me.recoil * me.recoil * 0.035, yaw + Math.PI, roll, 'YXZ');
      if (this.input.zoom && st !== 'transition') fov = 34;
      this.deathCam = null;
    } else {
      if (!this.deathCam) this.deathCam = { a: this.lookYaw, t: 0, from: cam.position.clone() };
      const d = this.deathCam;
      d.t += real; d.a += real * 0.22;
      const k = Math.min(1, d.t / 1.3), e = k * k * (3 - 2 * k);
      // orbit high over the wreck, kept inside the arena so the outer wall never blocks the view
      const { HW, HH } = this.world;
      const ox = clamp(me.x - Math.sin(d.a) * 5, -HW + 1, HW - 1);
      const oz = clamp(me.z - Math.cos(d.a) * 5, -HH + 1, HH - 1);
      cam.position.lerpVectors(d.from, _dir.set(ox, 7.5, oz), e);
      cam.lookAt(me.x, 0.6, me.z);
    }
    const tr = this.effects.trauma;
    if (tr > 0) {
      const s = tr * tr;
      cam.position.x += (Math.random() - 0.5) * 0.16 * s;
      cam.position.y += (Math.random() - 0.5) * 0.12 * s;
      cam.rotation.z += (Math.random() - 0.5) * 0.035 * s;
    }
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = lerp(cam.fov, fov, 1 - Math.exp(-real * 12)); cam.updateProjectionMatrix(); }
    cam.getWorldDirection(_dir);
    this.viewYaw = Math.atan2(_dir.x, _dir.z);
  }

  updateAimDots() {
    const mesh = this.aimDots, me = this.player;
    const inPlay = this.mp ? (this.state === 'mp' && this.mp.hasSlot() && !!this.mp.settings.al && (this.mp.phase === 'pl' || this.mp.phase === 'cd'))
      : (this.state === 'playing' || this.state === 'countdown');
    const show = this.settings.aimLine && me.alive && inPlay;
    if (!show) { mesh.count = 0; return; }
    const c = me.turretCenter();
    const pts = this.world.tracePath(c.x, c.z, Math.sin(me.turretYaw), Math.cos(me.turretYaw), me.params.bounces, 36, SHELL_RADIUS, 0.08);
    const m = new THREE.Matrix4(), col = new THREE.Color();
    let n = 0, next = me.muzzleForward + 1.1, bounces = 0, bounceAt = 0;
    for (let i = 1; i < pts.length && n < 96; i++) {
      const a = pts[i - 1], b = pts[i];
      const len = b.d - a.d;
      while (next <= b.d && n < 96 && len > 1e-6) {
        if (bounces > 0 && next - bounceAt > 10) break;
        const t = (next - a.d) / len;
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        next += 0.7;
        // dots right next to the camera (a ricochet coming back) would fill the screen
        if ((x - this.camera.position.x) ** 2 + (z - this.camera.position.z) ** 2 < 4) continue;
        m.makeTranslation(x, SHELL_Y - 0.05, z);
        mesh.setMatrixAt(n, m);
        const fade = 1 - Math.min(1, next / 36) * 0.5;
        if (bounces) col.setRGB(2.0 * fade, 0.55 * fade, 0.25 * fade); else col.setRGB(1.5 * fade, 1.0 * fade, 0.45 * fade);
        mesh.setColorAt(n, col);
        n++;
      }
      if (b.bounce) { bounces++; bounceAt = b.d; }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
  }

  // ---------- menus ----------
  bindUI() {
    const click = () => this.audio.play('ui_click', { volume: 0.5 });
    document.querySelectorAll('button').forEach((b) => b.addEventListener('mouseenter', () => this.audio.play('ui_hover', { volume: 0.25 })));

    const syncMenu = () => {
      document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === this.menuMode)));
      document.querySelectorAll('[data-diff]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.diff === this.diff)));
      document.querySelectorAll('[data-size]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.size === this.arenaSize)));
      $('mode-desc').textContent = MODE_TEXT[this.menuMode];
      $('diff-desc').textContent = DIFF_TEXT[this.diff];
      $('diff-group').hidden = this.menuMode !== 'duel';
      $('best-line').hidden = this.menuMode !== 'gauntlet';
      $('best-line').textContent = `Best gauntlet run: level ${this.best}`;
    };
    document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      this.audio.unlock(); click(); this.menuMode = b.dataset.mode; store.set('ricochet-mode', this.menuMode); syncMenu();
    }));
    document.querySelectorAll('[data-diff]').forEach((b) => b.addEventListener('click', () => {
      this.audio.unlock(); click(); this.diff = b.dataset.diff; store.set('ricochet-diff', this.diff); syncMenu();
    }));
    document.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => {
      this.audio.unlock(); click(); this.arenaSize = b.dataset.size; store.set('ricochet-size', this.arenaSize); syncMenu();
      if (this.state === 'menu' && !this.mp) this.resetAttract(); // preview the new size behind the menu
    }));
    syncMenu();

    const deploy = () => {
      this.audio.unlock(); click();
      this.input.requestLock();
      this.startMatch(this.menuMode, this.diff);
    };
    $('deploy').addEventListener('click', deploy);
    $('rematch').addEventListener('click', deploy);
    $('to-menu').addEventListener('click', () => { click(); this.quitToMenu(); });
    $('resume').addEventListener('click', () => { click(); this.resume(); });
    $('quit').addEventListener('click', () => { click(); if (this.mp) this.mp.end(''); else this.quitToMenu(); });

    // settings
    const s = this.settings;
    const bindRange = (id, key, fmt) => {
      const el = $(id), out = $(id + '-val');
      el.value = s[key]; out.textContent = fmt(s[key]);
      el.addEventListener('input', () => { s[key] = parseFloat(el.value); out.textContent = fmt(s[key]); if (key === 'volume') this.audio.setVolume(this.state === 'menu' ? s.volume * 0.25 : s.volume); store.set('ricochet-settings', s); });
    };
    bindRange('set-sens', 'sensitivity', (v) => v.toFixed(2) + '×');
    bindRange('set-vol', 'volume', (v) => Math.round(v * 100) + '%');
    bindRange('set-fov', 'fov', (v) => Math.round(v) + '°');
    for (const [id, key] of [['set-controls', 'controls'], ['set-quality', 'quality']]) {
      const el = $(id);
      el.value = s[key];
      el.addEventListener('change', () => { s[key] = el.value; if (key === 'quality') this.applySettings(); else store.set('ricochet-settings', s); });
    }
    for (const [id, key] of [['set-aim', 'aimLine'], ['set-invert', 'invertY']]) {
      const el = $(id);
      el.checked = s[key];
      el.addEventListener('change', () => { s[key] = el.checked; store.set('ricochet-settings', s); });
    }

    // pause handling
    this.input.onLockChange = (locked) => {
      const hint = $('lock-hint');
      if (locked) { hint.hidden = true; return; }
      if (this.input.lockFailed) {
        // this browser view refuses mouse capture: aiming still follows the mouse, explain the edges once
        if (!this.lockHintShown && this.inMatch()) {
          this.lockHintShown = true;
          hint.textContent = 'Mouse capture is blocked in this window. Aim still follows your mouse; push against the left or right edge to keep turning';
          hint.hidden = false;
          setTimeout(() => { hint.hidden = true; }, 7000);
        }
        return;
      }
      this.unlockedAt = performance.now();
      // only the player pressing Esc pauses; the game letting go of the mouse (results, lobby) does not
      const ours = performance.now() - (this.input.releasedAt || 0) < 600;
      if (this.inMatch() && !this.paused && !ours && $('results').hidden) this.pause();
    };
    this.canvas.addEventListener('click', () => { if (this.inMatch() && !this.paused) this.input.requestLock(); });
    addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      // Esc that just released the mouse already paused the game; don't toggle it straight back
      const justUnlocked = performance.now() - (this.unlockedAt || 0) < 400;
      const menuOpen = this.paused || !$('pause').hidden;
      if (e.code === 'Escape' && this.inMatch() && !this.input.locked && !justUnlocked && $('results').hidden) { if (menuOpen) this.resume(); else this.pause(); }
      if (e.code === 'KeyH' && this.inMatch()) $('hint').classList.toggle('show');
    });
    // a multiplayer match keeps running for everyone else, so only single player pauses on tab switch
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.inMatch() && !this.paused && !this.mp) this.pause();
    });

    if (matchMedia('(pointer: coarse)').matches) {
      this.input.setupTouch($('touch-ui'));
      $('touch-ui').hidden = false;
      document.body.classList.add('touch');
    }
  }

  inMatch() { return ['countdown', 'playing', 'roundOver', 'transition', 'mp'].includes(this.state); }

  // In multiplayer the menu opens over a match that keeps running.
  pause() {
    this.paused = !this.mp;
    this.input.enabled = false;
    if (this.mp) this.mpUi.closeChat();
    $('quit').textContent = this.mp ? 'Leave match' : 'Quit';
    document.body.classList.remove('playing');
    $('pause').hidden = false;
    $('pause-settings-slot').append($('settings'));
    this.audio.updateEngine(this.playerEngine, 0, 0, 0, false);
    this.audio.updateEngine(this.botEngine, 0, 0, 0, false);
  }

  resume() {
    $('pause').hidden = true;
    $('menu-settings-slot').append($('settings'));
    this.paused = false;
    this.input.enabled = true;
    document.body.classList.add('playing');
    this.input.requestLock();
    this.clock.getDelta();
  }

  quitToMenu() {
    $('pause').hidden = true;
    $('results').hidden = true;
    $('menu-settings-slot').append($('settings'));
    this.input.releaseLock();
    document.body.classList.remove('playing');
    this.audio.updateEngine(this.playerEngine, 0, 0, 0, false);
    this.audio.updateEngine(this.botEngine, 0, 0, 0, false);
    this.startAttract();
    $('menu').hidden = false;
  }
}

function boot(data) {
  const game = new Game(data || {});
  window.__game = game;
  window.claude?.hot?.snapshot?.(() => ({ settings: game.settings }));
  game.init();
}

if (window.claude?.hot?.ready) window.claude.hot.ready(boot);
else boot(window.claude?.hot?.data ?? {});
