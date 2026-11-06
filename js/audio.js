// Web Audio: positional one-shots, synthesized cannon punch and engine loops.
const FILES = {
  fire: ['fire_0', 'fire_1'], boom: ['boom_0', 'boom_1'], ricochet: ['ricochet_0', 'ricochet_1', 'ricochet_2'],
  crate_break: ['crate_break'], engine_loop: ['engine_loop'], round_start: ['round_start'],
  hit_stone: ['hit_stone'], hit_wood: ['hit_wood'], shell_clash: ['shell_clash'], mine_drop: ['mine_drop'],
  tank_bump: ['tank_bump'], ui_click: ['ui_click'], ui_hover: ['ui_hover'], win: ['win'], lose: ['lose'],
  mine_beep: ['mine_beep'], countdown: ['countdown'], reload: ['reload'],
};

export class AudioEngine {
  constructor() {
    this.buffers = {};
    this.volume = 0.8;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = AC ? new AC() : null;
    if (!this.ctx) return;
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 4;
    this.master.connect(comp).connect(this.ctx.destination);
    this.noise = this.makeNoise();
  }

  async load(onProgress) {
    if (!this.ctx) return;
    const names = Object.values(FILES).flat();
    let done = 0;
    await Promise.all(names.map(async (n) => {
      try {
        const res = await fetch('assets/audio/' + n + '.ogg');
        const data = await res.arrayBuffer();
        this.buffers[n] = await new Promise((ok, fail) => this.ctx.decodeAudioData(data, ok, fail));
      } catch { /* a missing sound should never block the game */ }
      onProgress(++done / names.length);
    }));
  }

  unlock() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume(); }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }

  makeNoise() {
    const len = this.ctx.sampleRate * 0.6;
    const b = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  panner(x, y, z, ref = 4) {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = ref; p.rolloffFactor = 1.1; p.maxDistance = 90;
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; }
    else p.setPosition(x, y, z);
    return p;
  }

  // opts: {x, y, z} for positional sound, volume, rate
  play(group, opts = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const list = FILES[group] || [group];
    const buf = this.buffers[list[Math.floor(Math.random() * list.length)]];
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 1;
    const g = this.ctx.createGain();
    g.gain.value = opts.volume ?? 1;
    src.connect(g);
    if (opts.x != null) g.connect(this.panner(opts.x, opts.y ?? 0.5, opts.z, opts.ref ?? 4)).connect(this.master);
    else g.connect(this.master);
    src.start();
    return src;
  }

  cannon(x, y, z, near) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    this.play('fire', near ? { volume: 0.7, rate: 1.1 + Math.random() * 0.1 } : { x, y, z, volume: 1, rate: 1.05 + Math.random() * 0.1 });
    // low punch: falling sine plus a filtered noise crack
    const t = this.ctx.currentTime;
    const out = this.ctx.createGain();
    if (near) out.connect(this.master); else out.connect(this.panner(x, y, z, 5)).connect(this.master);
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(36, t + 0.28);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(near ? 0.9 : 0.7, t + 0.006);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
    o.connect(og).connect(out);
    o.start(t); o.stop(t + 0.4);
    const n = this.ctx.createBufferSource();
    n.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.setValueAtTime(2400, t); f.frequency.exponentialRampToValueAtTime(300, t + 0.25);
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(near ? 0.5 : 0.4, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    n.connect(f).connect(ng).connect(out);
    n.start(t); n.stop(t + 0.32);
  }

  boom(x, y, z, size = 1) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    this.play('boom', { x, y, z, volume: 1.4 * size, rate: 0.85 + Math.random() * 0.15, ref: 7 });
    this.play('crate_break', { x, y, z, volume: 0.7 * size, rate: 0.7, ref: 6 });
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(24, t + 0.7);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9 * size, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(g).connect(this.panner(x, y, z, 8)).connect(this.master);
    o.start(t); o.stop(t + 1);
  }

  // Looping engine sound for a tank. Returns a handle for updateEngine.
  engine(spatial) {
    if (!this.ctx || !this.buffers.engine_loop) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.engine_loop;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g);
    let p = null;
    if (spatial) { p = this.panner(0, 0.5, 0, 3); g.connect(p).connect(this.master); }
    else g.connect(this.master);
    src.start();
    return { src, g, p };
  }

  updateEngine(h, speed01, x, z, on) {
    if (!h) return;
    const t = this.ctx.currentTime;
    h.src.playbackRate.setTargetAtTime(0.55 + speed01 * 0.55, t, 0.1);
    h.g.gain.setTargetAtTime(on ? 0.1 + speed01 * 0.16 : 0, t, 0.15);
    if (h.p) {
      if (h.p.positionX) { h.p.positionX.value = x; h.p.positionZ.value = z; }
      else h.p.setPosition(x, 0.5, z);
    }
  }

  stopEngine(h) { if (h) { try { h.src.stop(); } catch { /* already stopped */ } } }

  setListener(pos, fwd) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = pos.x; l.positionY.value = pos.y; l.positionZ.value = pos.z;
      l.forwardX.value = fwd.x; l.forwardY.value = fwd.y; l.forwardZ.value = fwd.z;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
    }
  }
}
