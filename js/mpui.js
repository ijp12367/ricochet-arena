// Multiplayer screens: join/create, lobby (players, settings, chat), in-game chat, scoreboard, results.
import { RoomTransport, PeerTransport, LocalTransport, makeCode, cleanCode } from './net.js';
import { PALETTE, PALETTE_NAMES, TEAM_NAMES, TEAM_COLORS, DEFAULT_SETTINGS, sanitizeText } from './mp.js';
import { store } from './utils.js';

const $ = (id) => document.getElementById(id);
const hex = (c) => '#' + c.toString(16).padStart(6, '0');

const SETTINGS_UI = [
  { key: 'sz', label: 'Arena size', type: 'select', str: true, options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['huge', 'Huge']] },
  { key: 'md', label: 'Mode', type: 'select', options: [[0, 'Last tank standing'], [1, 'Deathmatch (respawns)']] },
  { key: 'tm', label: 'Teams', type: 'select', options: [[0, 'Free for all'], [1, 'Blue vs Red']] },
  { key: 'rw', label: 'Rounds to win', type: 'range', min: 1, max: 10, step: 1, show: (s) => !s.md },
  { key: 'kl', label: 'Kill limit', type: 'range', min: 3, max: 40, step: 1, show: (s) => !!s.md },
  { key: 'cd', label: 'Shot delay', type: 'range', min: 0.1, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) + ' s' },
  { key: 'ms', label: 'Shells in the air', type: 'range', min: 1, max: 8, step: 1 },
  { key: 'bn', label: 'Ricochets per shell', type: 'range', min: 0, max: 3, step: 1 },
  { key: 'ss', label: 'Shell speed', type: 'select', options: [[0, 'Slow'], [1, 'Normal'], [2, 'Fast'], [3, 'Rocket']] },
  { key: 'mn', label: 'Mines per tank', type: 'range', min: 0, max: 4, step: 1 },
  { key: 'vs', label: 'Tank speed', type: 'select', options: [[0.8, 'Slow'], [1, 'Normal'], [1.25, 'Fast']] },
  { key: 'mk', label: 'Opponent markers', type: 'select', options: [[0, 'Off'], [1, 'Only in line of sight'], [2, 'Always, through walls']] },
  { key: 'al', label: 'Aim line allowed', type: 'toggle' },
  { key: 'tw', label: 'Incoming-shell warnings', type: 'toggle' },
  { key: 'ff', label: 'Friendly fire', type: 'toggle', show: (s) => !!s.tm },
  { key: 'nb', label: 'Bots', type: 'range', min: 0, max: 7, step: 1 },
  { key: 'bd', label: 'Bot skill', type: 'select', str: true, options: [['recruit', 'Recruit'], ['regular', 'Regular'], ['veteran', 'Veteran'], ['ace', 'Ace']], show: (s) => s.nb > 0 },
];

export class MpUi {
  constructor(game) {
    this.game = game;
    this.net = null;          // detected transport kind
    this.lobbyRoom = null;
    this.chatting = false;
    this.renderT = 0; this.lastVersion = -1; this.lastSettings = '';
    this.name = store.get('ricochet-callsign', 'Tanker' + Math.floor(10 + Math.random() * 89));
    this.color = store.get('ricochet-color', Math.floor(Math.random() * PALETTE.length));
    this.buildSwatches($('mp-colors'), (i) => { this.color = i; store.set('ricochet-color', i); this.markSwatches(); });
    this.buildSwatches($('lobby-colors'), (i) => { this.color = i; store.set('ricochet-color', i); this.markSwatches(); this.game.mp?.setProfile({ c: i }); });
    this.markSwatches();
    this.buildSettings();
    this.bind();
  }

  // ---------- network detection ----------
  async detect() {
    if (this.net) return this.net;
    const qs = new URLSearchParams(location.search);
    if (qs.get('net') === 'local') return (this.net = { kind: 'local', note: 'Test mode: only tabs in this browser can join.' });
    const room = await RoomTransport.lobbyRoom();
    if (room) {
      this.lobbyRoom = room;
      return (this.net = { kind: 'room', note: 'Online through claude.ai. Friends must be signed in and invited to this page from its Share menu.' });
    }
    if (window.RICOCHET_PACKED) return (this.net = { kind: 'none', note: 'Multiplayer on this page needs you to be signed in to claude.ai and invited to the game. Ask the owner to share it with you.' });
    if (PeerTransport.supported()) return (this.net = { kind: 'peer', note: 'Peer-to-peer over the internet. Each friend opens their own copy of the game and joins with your code.' });
    return (this.net = { kind: 'none', note: 'This browser cannot make peer-to-peer connections.' });
  }

  async openNet(code, asHost) {
    const kind = this.net.kind;
    if (kind === 'room') {
      const net = new RoomTransport(this.lobbyRoom);
      const c = asHost ? makeCode() : code;
      await net.open(c);
      return { net, code: c };
    }
    if (kind === 'local') {
      const net = new LocalTransport();
      const c = asHost ? makeCode() : code;
      await net.open(c);
      return { net, code: c };
    }
    if (kind === 'peer') {
      for (let i = 0; i < 4; i++) {
        const c = asHost ? makeCode() : code;
        const net = new PeerTransport();
        try { await net.open(c, asHost); return { net, code: c }; } catch (e) {
          net.close();
          if (e.message === 'code-taken' && asHost) continue;
          throw e;
        }
      }
      throw new Error('Could not reserve a lobby code. Try again.');
    }
    throw new Error(this.net.note);
  }

  // A link friends can open to land in this lobby. The hosted page knows its public address
  // from the build; a page on a normal website uses its own; a local copy has none.
  inviteLink(code) {
    const local = location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    const base = window.RICOCHET_SHARE_URL || (local ? null : location.origin + location.pathname);
    return base ? `${base}#join-${code}` : null;
  }

  // Opened from an invite link (#join-ABCD): go straight to the join screen.
  checkInvite() {
    const m = /^#join-([A-Za-z0-9]{4})$/.exec(location.hash || '');
    if (m) this.showEntry(cleanCode(m[1]));
  }

  // ---------- screens ----------
  async showEntry(inviteCode = '') {
    this.hideAll();
    $('menu').hidden = true;
    $('mp-entry').hidden = false;
    $('mp-name').value = this.name;
    $('mp-status').textContent = '';
    const invited = !!inviteCode;
    $('mp-invite').hidden = !invited;
    if (invited) {
      $('mp-invite').textContent = `You're invited to lobby ${inviteCode}. Pick a callsign and press Join lobby.`;
      $('mp-code').value = inviteCode;
      $('mp-name').focus();
    }
    $('mp-join').className = invited ? 'cta' : 'ghost';
    $('mp-create').className = invited ? 'ghost' : 'cta';
    $('mp-net').textContent = 'Checking how this page can connect…';
    const d = await this.detect();
    $('mp-net').textContent = d.note;
    const ok = d.kind !== 'none';
    $('mp-create').disabled = !ok; $('mp-join').disabled = !ok; $('mp-code').disabled = !ok;
    $('mp-list-wrap').hidden = d.kind !== 'room';
    if (d.kind === 'room') this.pollLobbies();
  }

  pollLobbies() {
    clearInterval(this.listTimer);
    const render = () => {
      if ($('mp-entry').hidden) { clearInterval(this.listTimer); return; }
      const list = RoomTransport.listLobbies(this.lobbyRoom);
      const ul = $('mp-list');
      ul.replaceChildren();
      if (!list.length) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'No open lobbies right now. Create one and share the code.';
        ul.append(li);
        return;
      }
      for (const l of list) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'lobby-pick';
        const n = document.createElement('span'); n.textContent = l.name || 'Lobby';
        const meta = document.createElement('span'); meta.className = 'meta';
        meta.textContent = `${l.code} · ${l.n} player${l.n === 1 ? '' : 's'}${l.ig ? ' · in a match' : ''}`;
        b.append(n, meta);
        b.addEventListener('click', () => { $('mp-code').value = l.code; this.join(); });
        li.append(b);
        ul.append(li);
      }
    };
    render();
    this.listTimer = setInterval(render, 1200);
  }

  showLobby() {
    const mp = this.game.mp;
    if (!mp) return;
    this.hideAll();
    $('menu').hidden = true;
    $('mp-lobby').hidden = false;
    $('lobby-code').textContent = mp.code;
    const link = this.inviteLink(mp.code);
    $('lobby-invite').hidden = !link;
    $('lobby-link').hidden = !link;
    $('lobby-link').textContent = link || '';
    this.lastVersion = -1; this.lastSettings = '';
    this.renderLobby(true);
  }

  showResults(rows, title) {
    const mp = this.game.mp;
    $('results-title').textContent = title.big;
    $('results-sub').textContent = title.small;
    const st = mp ? mp.settings : DEFAULT_SETTINGS;
    $('results-stats').innerHTML = '';
    for (const r of rows.slice(0, 8)) {
      const d = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = r.name + (r.me ? ' (you)' : '');
      dt.style.color = hex(r.color);
      const dd = document.createElement('dd');
      dd.textContent = st.md ? `${r.score} kills` : `${r.score} round${r.score === 1 ? '' : 's'}`;
      d.append(dt, dd);
      $('results-stats').append(d);
    }
    const host = mp && mp.isHost;
    $('rematch').hidden = true; $('to-menu').hidden = true;
    $('results-again').hidden = !host; $('results-lobby').hidden = !host; $('results-leave').hidden = false;
    $('results-wait').hidden = host;
    $('results').hidden = false;
    this.game.input.releaseLock();
    document.body.classList.remove('playing');
  }

  hideResults() {
    if (!$('results').hidden && this.game.mp) {
      $('results').hidden = true;
      document.body.classList.add('playing');
    }
  }

  restoreSinglePlayerResults() {
    $('rematch').hidden = false; $('to-menu').hidden = false;
    $('results-again').hidden = true; $('results-lobby').hidden = true; $('results-leave').hidden = true; $('results-wait').hidden = true;
  }

  hideAll() {
    $('mp-entry').hidden = true;
    $('mp-lobby').hidden = true;
    $('results').hidden = true;
    this.restoreSinglePlayerResults();
  }

  setInGame(on) {
    $('chat').hidden = !on;
    if (!on) this.closeChat();
    $('scoreboard').hidden = true;
  }

  // ---------- actions ----------
  readName() {
    const n = sanitizeText($('mp-name').value, 16);
    if (n) { this.name = n; store.set('ricochet-callsign', n); }
    return n;
  }

  async create() {
    if (!this.readName()) { $('mp-status').textContent = 'Pick a callsign first.'; return; }
    this.busy(true, 'Creating a lobby…');
    try {
      const { net, code } = await this.openNet(null, true);
      this.game.startMp(net, { code, isHost: true, name: this.name, color: this.color, settings: store.get('ricochet-lobby', null) });
      this.showLobby();
    } catch (e) { $('mp-status').textContent = e.message || 'Could not create a lobby.'; }
    this.busy(false);
  }

  async join() {
    if (!this.readName()) { $('mp-status').textContent = 'Pick a callsign first.'; return; }
    const code = cleanCode($('mp-code').value);
    if (code.length !== 4) { $('mp-status').textContent = 'Enter the 4-character lobby code.'; return; }
    this.busy(true, `Joining ${code}…`);
    try {
      const { net } = await this.openNet(code, false);
      this.game.startMp(net, { code, isHost: false, name: this.name, color: this.color });
      this.showLobby();
    } catch (e) { $('mp-status').textContent = e.message || 'Could not join that lobby.'; }
    this.busy(false);
  }

  busy(on, text) {
    for (const id of ['mp-create', 'mp-join']) $(id).disabled = on;
    if (text) $('mp-status').textContent = text;
  }

  // ---------- lobby rendering ----------
  buildSwatches(root, pick) {
    PALETTE.forEach((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.style.setProperty('--sw', hex(c));
      b.title = PALETTE_NAMES[i];
      b.setAttribute('aria-label', PALETTE_NAMES[i] + ' tank');
      b.dataset.i = i;
      b.addEventListener('click', () => pick(i));
      root.append(b);
    });
  }

  markSwatches() {
    document.querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.i === this.color)));
  }

  buildSettings() {
    const root = $('lobby-settings');
    this.settingEls = {};
    for (const def of SETTINGS_UI) {
      const row = document.createElement('div');
      row.className = 'srow';
      const id = 'mps-' + def.key;
      const label = document.createElement('label');
      label.htmlFor = id;
      label.textContent = def.label;
      row.append(label);
      let input, out = null;
      if (def.type === 'select') {
        input = document.createElement('select');
        for (const [v, t] of def.options) { const o = document.createElement('option'); o.value = String(v); o.textContent = t; input.append(o); }
      } else if (def.type === 'range') {
        input = document.createElement('input');
        input.type = 'range'; input.min = def.min; input.max = def.max; input.step = def.step;
        out = document.createElement('output');
        row.append(out);
      } else {
        input = document.createElement('input');
        input.type = 'checkbox';
      }
      input.id = id;
      row.append(input);
      root.append(row);
      const read = () => {
        if (def.type === 'toggle') return input.checked ? 1 : 0;
        if (def.str) return input.value;
        return parseFloat(input.value);
      };
      input.addEventListener(def.type === 'range' ? 'input' : 'change', () => {
        const mp = this.game.mp;
        if (!mp || !mp.isHost) return;
        const v = read();
        if (out) out.textContent = def.fmt ? def.fmt(v) : String(v);
        mp.setSettings({ [def.key]: v });
        store.set('ricochet-lobby', mp.settings);
      });
      this.settingEls[def.key] = { def, row, input, out };
    }
  }

  syncSettings(st, editable) {
    for (const { def, row, input, out } of Object.values(this.settingEls)) {
      const v = st[def.key];
      if (document.activeElement !== input) {
        if (def.type === 'toggle') input.checked = !!v;
        else input.value = String(v);
      }
      if (out) out.textContent = def.fmt ? def.fmt(+v) : String(v);
      input.disabled = !editable;
      row.hidden = def.show ? !def.show(st) : false;
    }
    $('lobby-hostonly').hidden = editable;
  }

  renderLobby(force = false) {
    const mp = this.game.mp;
    if (!mp || $('mp-lobby').hidden) return;
    if (force || mp.version !== this.lastVersion) {
      this.lastVersion = mp.version;
      const players = mp.lobbyPlayers();
      const ul = $('lobby-players');
      ul.replaceChildren();
      for (const p of players) {
        const li = document.createElement('li');
        const sw = document.createElement('i');
        sw.className = 'dot';
        sw.style.background = hex(mp.settings.tm ? TEAM_COLORS[p.team] : p.color);
        const nm = document.createElement('span');
        nm.className = 'pname';
        nm.textContent = p.name + (p.isMe ? ' (you)' : '');
        const tags = document.createElement('span');
        tags.className = 'tags';
        const bits = [];
        if (p.isHost) bits.push('HOST');
        if (mp.settings.tm) bits.push(TEAM_NAMES[p.team].toUpperCase());
        if (!p.isHost) bits.push(p.ready ? 'READY' : 'NOT READY');
        tags.textContent = bits.join(' · ');
        if (p.ready || p.isHost) li.classList.add('ready');
        li.append(sw, nm, tags);
        ul.append(li);
      }
      for (let b = 0; b < Math.min(mp.settings.nb, Math.max(0, 8 - players.length)); b++) {
        const li = document.createElement('li');
        li.className = 'bot';
        const sw = document.createElement('i'); sw.className = 'dot';
        const nm = document.createElement('span'); nm.className = 'pname'; nm.textContent = `BOT ${b + 1}`;
        const tags = document.createElement('span'); tags.className = 'tags'; tags.textContent = mp.settings.bd.toUpperCase();
        li.append(sw, nm, tags);
        ul.append(li);
      }
      const total = players.length + Math.min(mp.settings.nb, Math.max(0, 8 - players.length));
      const notReady = players.filter((p) => !p.isHost && !p.ready).length;
      $('lobby-start').hidden = !mp.isHost;
      $('lobby-ready').hidden = mp.isHost;
      $('lobby-start').disabled = total < 2;
      const meReady = !!mp.me.r;
      $('lobby-ready').textContent = meReady ? 'Not ready' : 'Ready';
      $('lobby-ready').setAttribute('aria-pressed', String(meReady));
      $('lobby-team').hidden = !mp.settings.tm;
      document.querySelectorAll('[data-team]').forEach((b) => b.setAttribute('aria-pressed', String((mp.me.t | 0) === +b.dataset.team)));
      let status;
      if (!mp.everSawHost && !mp.isHost) status = 'Connecting to the host…';
      else if (mp.isHost) status = total < 2 ? 'Waiting for players. Share the code, or add bots.' : notReady ? `${notReady} player${notReady === 1 ? ' is' : 's are'} not ready yet. You can still start.` : 'Everyone is ready.';
      else status = mp.phase === 'lb' ? 'Waiting for the host to start the match.' : 'A match is running. You will join at the next round.';
      $('lobby-status').textContent = status;
    }
    const sig = JSON.stringify(mp.settings) + mp.isHost;
    if (force || sig !== this.lastSettings) { this.lastSettings = sig; this.syncSettings(mp.settings, mp.isHost); }
  }

  onChat(msg) {
    for (const id of ['lobby-chat', 'chat-log']) {
      const log = $(id);
      const line = document.createElement('div');
      line.className = 'cl' + (msg.sys ? ' sys' : '');
      if (msg.sys) line.textContent = msg.text;
      else {
        const who = document.createElement('b');
        who.textContent = msg.name + ': ';
        who.style.color = hex(msg.color);
        const t = document.createElement('span');
        t.textContent = msg.text;
        line.append(who, t);
      }
      log.append(line);
      while (log.children.length > 40) log.firstChild.remove();
      if (id === 'chat-log') setTimeout(() => line.classList.add('old'), 9000);
      log.scrollTop = log.scrollHeight;
    }
  }

  clearChat() { $('lobby-chat').replaceChildren(); $('chat-log').replaceChildren(); }

  // ---------- in-game chat and scoreboard ----------
  openChat() {
    if (!this.game.mp) return;
    this.chatting = true;
    $('chat').classList.add('open');
    $('chat-form').hidden = false;
    const input = $('chat-input');
    input.value = '';
    input.focus();
  }

  closeChat() {
    this.chatting = false;
    $('chat').classList.remove('open');
    $('chat-form').hidden = true;
    $('chat-input').blur();
  }

  update(dt) {
    this.renderT -= dt;
    if (this.renderT <= 0) { this.renderT = 0.2; this.renderLobby(); }
    const sb = $('scoreboard');
    const want = this.game.mp && this.game.mp.inGame && this.game.input.key('Tab') && !this.chatting;
    if (sb.hidden === !!want) sb.hidden = !want;
    if (want) this.renderScoreboard();
  }

  renderScoreboard() {
    const mp = this.game.mp;
    const rows = mp.standings();
    const body = $('sb-body');
    body.replaceChildren();
    $('sb-score-h').textContent = mp.settings.md ? 'Kills' : 'Rounds';
    if (mp.settings.tm) {
      const ts = mp.teamScores();
      $('sb-title').textContent = `${TEAM_NAMES[0]} ${ts[0]} : ${ts[1]} ${TEAM_NAMES[1]}`;
    } else $('sb-title').textContent = mp.settings.md ? `Deathmatch · first to ${mp.settings.kl}` : `Last tank standing · first to ${mp.settings.rw}`;
    for (const r of rows) {
      const tr = document.createElement('tr');
      if (r.me) tr.className = 'me';
      const a = document.createElement('td');
      const dot = document.createElement('i'); dot.className = 'dot'; dot.style.background = hex(r.color);
      const nm = document.createElement('span'); nm.textContent = r.name + (mp.settings.tm ? ` (${TEAM_NAMES[r.team]})` : '');
      a.append(dot, nm);
      const b = document.createElement('td'); b.textContent = r.score;
      const c = document.createElement('td'); c.textContent = r.alive ? 'In action' : 'Destroyed';
      tr.append(a, b, c);
      body.append(tr);
    }
  }

  // ---------- events ----------
  bind() {
    $('mp-open').addEventListener('click', () => { this.game.audio.unlock(); this.showEntry(); });
    $('mp-back').addEventListener('click', () => { this.hideAll(); $('menu').hidden = false; });
    $('mp-create').addEventListener('click', () => this.create());
    $('mp-join').addEventListener('click', () => this.join());
    $('mp-code').addEventListener('input', (e) => { e.target.value = cleanCode(e.target.value); });
    $('mp-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.join(); });
    $('mp-name').addEventListener('change', () => this.readName());
    const copy = async (btn, text, node, label) => {
      try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
      catch { const r = document.createRange(); r.selectNodeContents(node); getSelection().removeAllRanges(); getSelection().addRange(r); btn.textContent = 'Selected, press Ctrl+C'; }
      setTimeout(() => { btn.textContent = label; }, 1800);
    };
    $('lobby-copy').addEventListener('click', () => copy($('lobby-copy'), $('lobby-code').textContent, $('lobby-code'), 'Copy code'));
    $('lobby-invite').addEventListener('click', () => copy($('lobby-invite'), $('lobby-link').textContent, $('lobby-link'), 'Copy invite link'));
    $('lobby-leave').addEventListener('click', () => this.game.mp?.end(''));
    $('lobby-ready').addEventListener('click', () => { const mp = this.game.mp; if (mp) mp.setProfile({ r: mp.me.r ? 0 : 1 }); this.renderLobby(true); });
    $('lobby-start').addEventListener('click', () => {
      const mp = this.game.mp;
      if (!mp || !mp.isHost) return;
      this.game.audio.unlock();
      this.game.input.requestLock();
      mp.hostStart();
    });
    document.querySelectorAll('[data-team]').forEach((b) => b.addEventListener('click', () => { this.game.mp?.setProfile({ t: +b.dataset.team }); this.renderLobby(true); }));
    $('lobby-chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('lobby-chat-input');
      this.game.mp?.sendChat(input.value);
      input.value = '';
    });
    $('chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.game.mp?.sendChat($('chat-input').value);
      this.closeChat();
    });
    $('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); this.closeChat(); } });
    $('results-again').addEventListener('click', () => { const mp = this.game.mp; if (mp && mp.isHost) { this.game.input.requestLock(); mp.hostStart(); } });
    $('results-lobby').addEventListener('click', () => this.game.mp?.hostBackToLobby());
    $('results-leave').addEventListener('click', () => this.game.mp?.end(''));
    addEventListener('keydown', (e) => {
      if (!this.game.mp || !this.game.mp.inGame) return;
      if (e.code === 'Tab') e.preventDefault();
      const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
      if (e.key === 'Enter' && !typing && !this.chatting && $('results').hidden) { e.preventDefault(); this.openChat(); }
    });
  }
}
