// Keyboard, mouse (pointer lock with a steer-by-cursor fallback) and touch controls.
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.dx = 0; this.dy = 0;          // accumulated mouse movement while locked
    this.fireHeld = false; this.firePressed = false;
    this.minePressed = false;
    this.zoom = false;
    this.locked = false;
    this.lockFailed = false;
    this.cursor = { x: 0.5, y: 0.5, inside: false };
    this.touch = { on: false, mx: 0, mz: 0, aim: 0 };
    this.pressed = new Set();          // key edges this frame
    this.enabled = false;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      // typing in a text box (chat, callsign) must not drive the tank
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (this.enabled && ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.fireHeld = false; this.zoom = false; });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      // the click that captures the mouse should not also fire a shell
      const capturing = !this.locked && !this.lockFailed && typeof canvas.requestPointerLock === 'function';
      if (e.button === 0 && !capturing) { this.fireHeld = true; this.firePressed = true; }
      if (e.button === 2) this.zoom = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fireHeld = false;
      if (e.button === 2) this.zoom = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // Mouse deltas drive the turret 1:1, whether or not the pointer is captured.
    this.skipMove = true;
    window.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.cursor.x = (e.clientX - r.left) / r.width;
      this.cursor.y = (e.clientY - r.top) / r.height;
      this.cursor.inside = this.cursor.x >= 0 && this.cursor.x <= 1 && this.cursor.y >= 0 && this.cursor.y <= 1;
      if (this.skipMove) { this.skipMove = false; return; }   // first event after entering reports a bogus jump
      if (this.enabled) {
        this.dx += Math.max(-300, Math.min(300, e.movementX || 0));
        this.dy += Math.max(-300, Math.min(300, e.movementY || 0));
      }
    });
    document.addEventListener('mouseleave', () => { this.cursor.inside = false; this.skipMove = true; });
    document.addEventListener('mouseenter', () => { this.skipMove = true; });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      this.skipMove = true;
      if (this.locked) this.lockFailed = false;
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => { this.lockFailed = true; if (this.onLockChange) this.onLockChange(false); });
  }

  // Ask for mouse capture. Safe to call on every click: a refusal just leaves the uncaptured mode on.
  requestLock() {
    if (this.locked || !this.canvas.requestPointerLock) return;
    try {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => { this.lockFailed = true; if (this.onLockChange) this.onLockChange(false); });
    } catch { this.lockFailed = true; }
  }

  releaseLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  key(code) { return this.keys.has(code); }
  hit(code) { return this.pressed.has(code); }

  // Call once per frame after reading.
  endFrame() {
    this.dx = 0; this.dy = 0;
    this.firePressed = false;
    this.minePressed = false;
    this.pressed.clear();
  }

  // On-screen controls for touch devices.
  setupTouch(root) {
    const stick = root.querySelector('#touch-stick'), knob = root.querySelector('#touch-knob');
    const aimPad = root.querySelector('#touch-aim'), fireBtn = root.querySelector('#touch-fire'), mineBtn = root.querySelector('#touch-mine');
    if (!stick) return;
    let stickId = null, aimId = null, aimLast = 0;
    const center = () => { const r = stick.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, rad: r.width / 2 }; };
    stick.addEventListener('pointerdown', (e) => { stickId = e.pointerId; stick.setPointerCapture(e.pointerId); move(e); });
    const move = (e) => {
      if (e.pointerId !== stickId) return;
      const c = center();
      let x = (e.clientX - c.x) / c.rad, y = (e.clientY - c.y) / c.rad;
      const l = Math.hypot(x, y);
      if (l > 1) { x /= l; y /= l; }
      this.touch.mx = x; this.touch.mz = -y;
      knob.style.transform = `translate(${x * 40}px, ${y * 40}px)`;
    };
    stick.addEventListener('pointermove', move);
    const endStick = (e) => { if (e.pointerId !== stickId) return; stickId = null; this.touch.mx = this.touch.mz = 0; knob.style.transform = ''; };
    stick.addEventListener('pointerup', endStick); stick.addEventListener('pointercancel', endStick);

    aimPad.addEventListener('pointerdown', (e) => { aimId = e.pointerId; aimLast = e.clientX; aimPad.setPointerCapture(e.pointerId); });
    aimPad.addEventListener('pointermove', (e) => { if (e.pointerId !== aimId) return; this.touch.aim += e.clientX - aimLast; aimLast = e.clientX; });
    const endAim = (e) => { if (e.pointerId === aimId) aimId = null; };
    aimPad.addEventListener('pointerup', endAim); aimPad.addEventListener('pointercancel', endAim);

    fireBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); this.firePressed = true; this.fireHeld = true; });
    fireBtn.addEventListener('pointerup', () => { this.fireHeld = false; });
    mineBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); this.minePressed = true; });
    this.touch.on = true;
  }
}
