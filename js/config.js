// Tunable constants and bot personalities.

export const CELL = 2;              // world units per grid cell
export const GRID_W = 20;
export const GRID_H = 14;
// arena sizes in cells (medium is the default)
export const SIZES = {
  small: { w: 14, h: 10, label: 'Small' },
  medium: { w: 20, h: 14, label: 'Medium' },
  large: { w: 26, h: 18, label: 'Large' },
  huge: { w: 32, h: 22, label: 'Huge' },
};

// Cell types
export const EMPTY = 0;
export const BLOCK = 1;   // tall concrete block, indestructible, blocks sight
export const LOW = 2;     // low wall, indestructible, you can see over it
export const CRATE = 3;   // crate stack, destroyed by mine blasts
export const TRAP = 4;    // tank trap: stops tanks, shells fly over

export const HEIGHT = { [BLOCK]: 2.3, [LOW]: 0.95, [CRATE]: 1.9, [TRAP]: 0.6 };
export const PERIMETER_HEIGHT = 2.7;

export const TANK_LENGTH = 1.75;
export const TANK_RADIUS = 0.74;     // movement collider
export const SHELL_Y = 0.66;         // shells fly at this height
export const SHELL_RADIUS = 0.13;
export const MINE_RADIUS = 0.34;
export const MINE_FUSE = 10;
export const MINE_TRIGGER = 1.7;     // enemy proximity that sets a mine off
export const MINE_BLAST = 3.3;       // blast radius

export const PLAYER = {
  speed: 4.3,
  reverseSpeed: 3.4,
  hullTurn: 2.7,
  shellSpeed: 11.5,
  bounces: 1,
  maxShells: 5,
  cooldown: 0.24,
  maxMines: 2,
};

// Bot archetypes. Numbers are tuned against PLAYER.
// aimError: radians of random spread. reaction: seconds before reacting to a threat.
// bank: how many ricochets the bot plans with. dodge: chance to notice a threat.
const base = {
  speed: 3.4, hullTurn: 2.4, turretTurn: 2.4,
  shellSpeed: 11, bounces: 1, maxShells: 3, cooldown: 1.0,
  maxMines: 0, mineRate: 0,
  aimError: 0.045, reaction: 0.4, bank: 1, lead: 0.5,
  dodge: 0.5, shootDown: false, aimInterval: 0.28,
  preferDist: 11, aggression: 0.5,
  model: 'desert', paint: 0x6d7f8c, name: 'REGULAR',
};

export const BOTS = {
  recruit: { ...base, name: 'RECRUIT', model: 'desert', paint: 0x5d7690,
    speed: 2.7, hullTurn: 2.0, turretTurn: 1.5, shellSpeed: 9.5, maxShells: 2, cooldown: 1.7,
    aimError: 0.09, reaction: 0.7, bank: 0, lead: 0, dodge: 0.15, aimInterval: 0.45, preferDist: 13, aggression: 0.35 },
  regular: { ...base, name: 'REGULAR', model: 'scout', paint: 0x8a3b32,
    speed: 3.3, turretTurn: 2.3, maxShells: 3, cooldown: 1.05, aimError: 0.045, reaction: 0.42,
    bank: 1, lead: 0.5, dodge: 0.45, maxMines: 1, mineRate: 0.03 },
  veteran: { ...base, name: 'VETERAN', model: 'heavy', paint: 0x3b3f52,
    speed: 3.9, hullTurn: 2.8, turretTurn: 3.2, shellSpeed: 12.5, bounces: 2, maxShells: 4, cooldown: 0.72,
    aimError: 0.022, reaction: 0.26, bank: 2, lead: 0.85, dodge: 0.78, shootDown: true,
    maxMines: 2, mineRate: 0.05, aimInterval: 0.2, preferDist: 10, aggression: 0.65 },
  ace: { ...base, name: 'ACE', model: 'heavy', paint: 0x1c1d22,
    speed: 4.4, hullTurn: 3.2, turretTurn: 4.2, shellSpeed: 18, bounces: 1, maxShells: 5, cooldown: 0.5,
    aimError: 0.01, reaction: 0.14, bank: 1, lead: 1, dodge: 0.95, shootDown: true,
    maxMines: 2, mineRate: 0.07, aimInterval: 0.14, preferDist: 9, aggression: 0.85 },
};

// Gauntlet: each level is a named variant with growing skill.
const G = (name, from, over) => ({ ...BOTS[from], ...over, name });
export const GAUNTLET = [
  G('RECRUIT', 'recruit', {}),
  G('BOUNCER', 'recruit', { bounces: 2, bank: 2, paint: 0x2f7d6d, model: 'scout', cooldown: 1.4, aimError: 0.06 }),
  G('SAPPER', 'regular', { maxMines: 2, mineRate: 0.12, paint: 0x9a7a2e, model: 'desert', aggression: 0.7 }),
  G('SPRINTER', 'regular', { speed: 4.8, hullTurn: 3.4, paint: 0xb0552a, model: 'scout', preferDist: 8 }),
  G('MARKSMAN', 'regular', { shellSpeed: 17, bounces: 0, bank: 0, aimError: 0.015, lead: 1, paint: 0x6b3f7a, model: 'desert', preferDist: 14 }),
  G('VETERAN', 'veteran', {}),
  G('HUNTER', 'veteran', { speed: 4.3, aggression: 0.9, preferDist: 8, paint: 0x7a2a2a }),
  G('ACE', 'ace', {}),
];

export function gauntletBot(level) {
  const i = Math.min(level - 1, GAUNTLET.length - 1);
  const b = { ...GAUNTLET[i] };
  const extra = Math.max(0, level - GAUNTLET.length);
  if (extra > 0) {           // past the list: keep sharpening the ace
    b.name = `ACE MK ${extra + 1}`;
    b.speed = Math.min(5.2, b.speed + extra * 0.15);
    b.cooldown = Math.max(0.3, b.cooldown - extra * 0.04);
    b.reaction = Math.max(0.08, b.reaction - extra * 0.01);
  }
  return b;
}

export const DUEL_TARGET = 5;      // round wins needed to take a duel
export const GAUNTLET_LIVES = 3;
