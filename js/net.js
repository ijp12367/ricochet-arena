// Network transports. Each one replicates a small state object per player with
// "merge patch" semantics: setState(patch) merges top-level fields into my state
// (null removes a field) and peers() returns everyone's latest merged state.
//   room  - claude.ai artifact room capability (presence), for the hosted page
//   peer  - WebRTC through PeerJS, host relays (star), for normal browsers
//   local - BroadcastChannel between tabs of one browser, for testing (?net=local)

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const makeCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
export const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
const randomId = (n = 8) => Array.from({ length: n }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)]).join('');

function merge(target, patch) {
  for (const k in patch) {
    if (patch[k] === null) delete target[k];
    else target[k] = patch[k];
  }
  return target;
}

class Transport {
  constructor() {
    this.me = {};          // my merged state
    this.list = new Map(); // id -> { id, isMe, state }
    this.myId = '';
    this.listeners = new Set();
  }
  peers() { return this.list; }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { for (const fn of this.listeners) fn(); }
  connected() { return true; }
}

// ---------- claude.ai room (presence) ----------
export class RoomTransport extends Transport {
  constructor(room) { super(); this.kind = 'room'; this.room = room; }

  static async lobbyRoom() {
    try { return window.claude && window.claude.use ? await window.claude.use('room') : null; } catch { return null; }
  }

  async open(code) {
    this.named = await this.room.join('ra-' + code.toLowerCase());
    this.unsub = this.named.onPeers((change) => this.sync(change.peers), () => { this.dead = true; this.changed(); });
    this.sync(this.named.peers());
  }

  // Read the room's snapshot directly: change callbacks are paced by animation frames,
  // which stall in background tabs.
  peers() {
    if (this.named) {
      const arr = this.named.peers();
      if (arr !== this.lastArr) { this.lastArr = arr; this.sync(arr); }
    }
    return this.list;
  }

  sync(peers) {
    const next = new Map();
    for (const p of peers) {
      if (p.kind !== 'viewer') continue;
      if (p.sameTab) this.myId = p.peer;
      next.set(p.peer, { id: p.peer, isMe: p.sameTab, state: p.sameTab ? this.me : (p.presence || {}) });
    }
    this.list = next;
    this.changed();
  }

  setState(patch) {
    merge(this.me, patch);
    if (this.named) this.named.presence(patch).catch(() => {});
  }

  connected() { return !this.dead && (this.named ? this.named.connected() : false); }

  async close() {
    if (this.unsub) this.unsub();
    if (this.named) await this.named.leave().catch(() => {});
  }

  // Open-game listing lives in the shared lobby room's presence.
  advertise(info) { this.room.presence({ lobby: info }).catch(() => {}); }
  static listLobbies(room) {
    const out = [];
    for (const p of room.peers()) {
      const l = p.presence && p.presence.lobby;
      if (l && typeof l.code === 'string' && !p.sameTab) out.push({ code: cleanCode(l.code), name: String(l.name || '').slice(0, 40), n: l.n | 0, ig: !!l.ig });
    }
    return out;
  }
}

// ---------- same-browser tabs (testing) ----------
export class LocalTransport extends Transport {
  constructor() { super(); this.kind = 'local'; this.myId = 'local-' + randomId(); this.pending = {}; this.lastSend = 0; }

  async open(code) {
    this.ch = new BroadcastChannel('ricochet-' + code);
    this.ch.onmessage = (e) => this.recv(e.data);
    this.list.set(this.myId, { id: this.myId, isMe: true, state: this.me });
    this.post({ t: 'full', id: this.myId, state: this.me, hello: true });
    this.timer = setInterval(() => this.tick(), 50);
    this.onUnload = () => this.post({ t: 'bye', id: this.myId });
    addEventListener('pagehide', this.onUnload);
  }

  post(m) { try { this.ch.postMessage(m); } catch { /* channel closed */ } }

  recv(m) {
    if (!m || m.id === this.myId) return;
    if (m.t === 'bye') { this.list.delete(m.id); this.changed(); return; }
    let p = this.list.get(m.id);
    if (!p) { p = { id: m.id, isMe: false, state: {}, seen: 0 }; this.list.set(m.id, p); if (m.t !== 'full') this.post({ t: 'want', id: this.myId }); }
    if (m.t === 'full') { p.state = { ...m.state }; if (m.hello) this.post({ t: 'full', id: this.myId, state: this.me }); }
    else if (m.t === 'want') this.post({ t: 'full', id: this.myId, state: this.me });
    else if (m.t === 'p') p.state = merge({ ...p.state }, m.patch);
    p.seen = performance.now();
    this.changed();
  }

  setState(patch) { merge(this.me, patch); Object.assign(this.pending, patch); }

  tick() {
    const now = performance.now();
    if (Object.keys(this.pending).length || now - this.lastSend > 1000) {
      this.post({ t: 'p', id: this.myId, patch: this.pending });
      this.pending = {};
      this.lastSend = now;
    }
    let gone = false;
    for (const [id, p] of this.list) if (!p.isMe && now - p.seen > 3500) { this.list.delete(id); gone = true; }
    if (gone) this.changed();
  }

  async close() {
    this.post({ t: 'bye', id: this.myId });
    clearInterval(this.timer);
    removeEventListener('pagehide', this.onUnload);
    try { this.ch.close(); } catch { /* already closed */ }
  }
}

// ---------- WebRTC via PeerJS (host relays every patch to everyone) ----------
let peerJsLoading = null;
function loadPeerJs() {
  if (window.Peer) return Promise.resolve();
  if (!peerJsLoading) {
    peerJsLoading = new Promise((ok, bad) => {
      const s = document.createElement('script');
      s.src = 'vendor/peerjs/peerjs.min.js';
      s.onload = ok;
      s.onerror = () => bad(new Error('Could not load the peer-to-peer library'));
      document.head.appendChild(s);
    });
  }
  return peerJsLoading;
}

export class PeerTransport extends Transport {
  constructor() { super(); this.kind = 'peer'; this.pending = {}; this.lastSend = 0; }

  static supported() { return typeof RTCPeerConnection !== 'undefined'; }

  async open(code, asHost) {
    await loadPeerJs();
    const hostId = 'ricochet-arena-' + code.toLowerCase();
    this.isHost = asHost;
    this.myId = asHost ? hostId : hostId + '-' + randomId(6);
    this.peer = new window.Peer(this.myId, { debug: 0 });
    await new Promise((ok, bad) => {
      const t = setTimeout(() => bad(new Error('The matchmaking server did not answer')), 12000);
      this.peer.on('open', () => { clearTimeout(t); ok(); });
      this.peer.on('error', (e) => {
        clearTimeout(t);
        bad(new Error(e.type === 'unavailable-id' ? 'code-taken' : e.type === 'peer-unavailable' ? 'No lobby found with that code' : 'Connection failed (' + (e.type || 'network') + ')'));
      });
    });
    this.list.set(this.myId, { id: this.myId, isMe: true, state: this.me });
    if (asHost) {
      this.conns = new Map();
      this.seen = new Map();   // peer id -> last time we heard from it
      this.outbox = [];
      this.peer.on('connection', (c) => this.accept(c));
    } else {
      const c = this.peer.connect(hostId, { serialization: 'json', reliable: true });
      await new Promise((ok, bad) => {
        const t = setTimeout(() => bad(new Error('No lobby found with that code')), 10000);
        c.on('open', () => { clearTimeout(t); ok(); });
        this.peer.on('error', (e) => { clearTimeout(t); bad(new Error(e.type === 'peer-unavailable' ? 'No lobby found with that code' : 'Connection failed')); });
      });
      this.hostConn = c;
      this.hostSeen = performance.now();
      c.on('data', (m) => { this.hostSeen = performance.now(); this.fromHost(m); });
      c.on('close', () => this.lostHost());
      c.send({ t: 'full', state: this.me });
    }
    this.lastBeat = 0;
    this.timer = setInterval(() => this.tick(), 50);
    // closing or reloading the tab hangs up at once instead of leaving a frozen tank behind
    this.onUnload = () => { try { this.peer.destroy(); } catch { /* already gone */ } };
    addEventListener('pagehide', this.onUnload);
  }

  accept(c) {
    c.on('open', () => {
      this.conns.set(c.peer, c);
      this.seen.set(c.peer, performance.now());
      const all = [...this.list.values()].map((p) => ({ id: p.id, state: p.isMe ? this.me : p.state }));
      c.send({ t: 'all', peers: all });
    });
    c.on('data', (m) => {
      if (!m || typeof m !== 'object') return;
      this.seen.set(c.peer, performance.now());
      if (m.t === 'hb') return;
      const p = this.list.get(c.peer) || { id: c.peer, isMe: false, state: {} };
      if (m.t === 'full') p.state = { ...m.state };
      else if (m.t === 'p') p.state = merge({ ...p.state }, m.patch || {});
      else return;
      this.list.set(c.peer, p);
      this.outbox.push({ id: c.peer, patch: m.t === 'full' ? m.state : m.patch, full: m.t === 'full' });
      this.changed();
    });
    c.on('close', () => this.dropConn(c.peer));
    c.on('error', () => this.dropConn(c.peer));
  }

  dropConn(id) {
    const c = this.conns.get(id);
    if (!c) return;
    this.conns.delete(id);
    this.seen.delete(id);
    this.list.delete(id);
    try { c.close(); } catch { /* already closed */ }
    for (const o of this.conns.values()) if (o.open) o.send({ t: 'bye', id });
    this.changed();
  }

  lostHost() {
    if (this.dead) return;
    this.dead = true;
    this.list = new Map([[this.myId, this.list.get(this.myId)]]);
    this.changed();
  }

  fromHost(m) {
    if (!m || typeof m !== 'object' || m.t === 'hb') return;
    if (m.t === 'all') {
      for (const q of m.peers) if (q.id !== this.myId) this.list.set(q.id, { id: q.id, isMe: false, state: { ...q.state } });
    } else if (m.t === 'u') {
      for (const u of m.items) {
        if (u.id === this.myId) continue;
        const p = this.list.get(u.id) || { id: u.id, isMe: false, state: {} };
        p.state = u.full ? { ...u.patch } : merge({ ...p.state }, u.patch || {});
        this.list.set(u.id, p);
      }
    } else if (m.t === 'bye') this.list.delete(m.id);
    this.changed();
  }

  setState(patch) { merge(this.me, patch); Object.assign(this.pending, patch); }

  tick() {
    const now = performance.now();
    const has = Object.keys(this.pending).length > 0;
    const beat = now - this.lastBeat > 1000;
    if (beat) this.lastBeat = now;
    if (this.isHost) {
      if (has) this.outbox.push({ id: this.myId, patch: this.pending, full: false });
      for (const [id, c] of this.conns) {
        // a player we have not heard from for 5 s is gone, whatever the connection claims
        if (now - (this.seen.get(id) || 0) > 5000) { this.dropConn(id); continue; }
        const items = this.outbox.filter((u) => u.id !== id);
        if (!c.open) continue;
        if (items.length) c.send({ t: 'u', items });
        else if (beat) c.send({ t: 'hb' });
      }
      this.outbox = [];
    } else if (this.hostConn && !this.dead) {
      if (now - this.hostSeen > 6000) this.lostHost();
      else if (this.hostConn.open) {
        if (has) { this.hostConn.send({ t: 'p', patch: this.pending }); this.lastSend = now; }
        else if (now - this.lastSend > 1000) { this.hostConn.send({ t: 'hb' }); this.lastSend = now; }
      }
    }
    if (has) this.pending = {};
  }

  connected() { return !this.dead; }

  async close() {
    clearInterval(this.timer);
    removeEventListener('pagehide', this.onUnload);
    try { this.peer.destroy(); } catch { /* already gone */ }
  }
}
