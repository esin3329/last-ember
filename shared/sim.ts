// 결정론적 게임 시뮬레이션 코어.
//
// 이 파일은 DOM/Node API를 전혀 쓰지 않는 순수 로직이다. 브라우저(플레이)와
// 서버(리플레이 검증)가 같은 코드를 실행하고, 같은 시드 + 같은 입력이면
// 항상 같은 결과가 나와야 한다. 그래서 다음 규칙을 지킨다.
//
//  1. 고정 타임스텝(60Hz)만 사용한다. 실제 프레임 시간은 들어오지 않는다.
//  2. 난수는 시드 RNG(rng.ts)만 쓴다.
//  3. 부동소수 연산은 + - * / sqrt 만 쓴다. sin/cos/atan2 같은 초월함수는
//     엔진마다 마지막 비트가 다를 수 있어서 쓰지 않고, 회전은 상수 회전 행렬로 처리한다.
//  4. 엔티티 순회 순서를 항상 같게 유지한다(배열 순서, 그리드 삽입 순서).
//  5. 연출용 이벤트(events)는 밖으로 내보내기만 하고 시뮬레이션에 영향을 주지 않는다.

import { type Rng, makeRng, nextFloat, nextInt } from './rng.ts';
import type { InputFrame } from './input.ts';
import {
  ARENA, BOLT, BOSS_TICK, CHAIN, DASH_CD, DASH_SPEED, DASH_TICKS, DT, ENEMY_DEFS,
  HIT_IFRAMES, Kind, MAX_TICKS, NOVA, ORBIT, PLAYER_HP, PLAYER_R, PLAYER_SPEED,
  UPGRADE_COUNT, UPGRADE_MAX, Up,
} from './defs.ts';

export interface Enemy {
  id: number;
  kind: Kind;
  x: number; y: number;
  px: number; py: number; // 이전 틱 위치 (렌더 보간용)
  kx: number; ky: number; // 넉백 속도
  hp: number; maxHp: number;
  r: number; speed: number; dmg: number;
  cd: number; cd2: number;
  flash: number;
  orbitCd: number;
  mark: number;
  dead: boolean;
}

export interface Bullet {
  x: number; y: number; px: number; py: number;
  vx: number; vy: number;
  dmg: number; life: number; pierce: number;
  lastHit: number;
  hostile: boolean;
}

export interface Gem {
  x: number; y: number; px: number; py: number;
  value: number;
  pulled: boolean;
}

export interface Player {
  x: number; y: number; px: number; py: number;
  fx: number; fy: number; // 바라보는 방향
  hp: number; maxHp: number;
  dashT: number; dashCd: number; dashDx: number; dashDy: number;
  iframes: number;
  level: number; xp: number; xpNext: number;
}

export type SimEvent =
  | { t: 'hit'; x: number; y: number; dmg: number }
  | { t: 'kill'; x: number; y: number; kind: Kind; r: number }
  | { t: 'shoot' }
  | { t: 'enemyShoot'; x: number; y: number }
  | { t: 'nova'; x: number; y: number; r: number }
  | { t: 'chain'; pts: number[] }
  | { t: 'gem' }
  | { t: 'dash' }
  | { t: 'playerHit'; dmg: number }
  | { t: 'levelup' }
  | { t: 'bossSpawn' }
  | { t: 'wave' }
  | { t: 'win' }
  | { t: 'dead' };

export type Phase = 'playing' | 'levelup' | 'dead' | 'won';

export interface SimState {
  rng: Rng;
  tick: number;
  phase: Phase;
  player: Player;
  levels: number[]; // 업그레이드별 레벨
  choices: number[]; // 레벨업 선택지 (업그레이드 인덱스)
  pendingLevels: number;
  enemies: Enemy[];
  bullets: Bullet[];
  gems: Gem[];
  boltCd: number; novaCd: number; chainCd: number;
  orbX: number; orbY: number; // 공전 칼날 기준 방향 벡터
  spawnAcc: number;
  bossSpawned: boolean;
  bossId: number;
  kills: number;
  score: number;
  nextId: number;
  markSeq: number;
  // 파생 스탯
  dmgMul: number; cdMul: number; speedMul: number; magnet: number; regen: number;
  // 연출용
  emit: boolean;
  events: SimEvent[];
  // 공간 분할 그리드 (연결 리스트 방식, 할당 없음)
  gridHead: Int32Array;
  gridNext: Int32Array;
  scratch: number[];
}

const CELL = 64;
const GW = Math.ceil(ARENA / CELL);
const MAX_ENEMIES = 320;
const SOFT_CAP = 290;
const MAX_R = 44;
const MAX_GEMS = 350;
const DIAG = 0.7071067811865476;

// 상수 회전 (cos, sin). 초월함수를 런타임에 부르지 않기 위해 리터럴로 둔다.
const ROT_ORBIT: readonly [number, number] = [0.9975640502598242, 0.0697564737441253]; // 4도/틱
const ROT_22: readonly [number, number] = [0.9238795325112867, 0.3826834323650898]; // 22.5도
const ROT_11: readonly [number, number] = [0.9807852804032304, 0.19509032201612825]; // 11.25도
const ROT_120: readonly [number, number] = [-0.5, 0.8660254037844386];

export function xpForLevel(level: number): number {
  return 4 + level * 3 + ((level * level) >> 2);
}

export function createSim(seed: number, emit = true): SimState {
  const levels = new Array<number>(UPGRADE_COUNT).fill(0);
  levels[Up.Bolt] = 1;
  const s: SimState = {
    rng: makeRng(seed),
    tick: 0,
    phase: 'playing',
    player: {
      x: ARENA / 2, y: ARENA / 2, px: ARENA / 2, py: ARENA / 2,
      fx: 1, fy: 0,
      hp: PLAYER_HP, maxHp: PLAYER_HP,
      dashT: 0, dashCd: 0, dashDx: 1, dashDy: 0,
      iframes: 0,
      level: 1, xp: 0, xpNext: xpForLevel(1),
    },
    levels,
    choices: [],
    pendingLevels: 0,
    enemies: [],
    bullets: [],
    gems: [],
    boltCd: 20, novaCd: 60, chainCd: 40,
    orbX: 1, orbY: 0,
    spawnAcc: 0,
    bossSpawned: false,
    bossId: -1,
    kills: 0,
    score: 0,
    nextId: 1,
    markSeq: 0,
    dmgMul: 1, cdMul: 1, speedMul: 1, magnet: 90, regen: 0,
    emit,
    events: [],
    gridHead: new Int32Array(GW * GW),
    gridNext: new Int32Array(MAX_ENEMIES),
    scratch: [],
  };
  recomputeStats(s);
  return s;
}

function recomputeStats(s: SimState): void {
  const L = s.levels;
  s.dmgMul = 1 + 0.12 * L[Up.Might];
  s.cdMul = 1 - 0.08 * L[Up.Haste];
  s.speedMul = 1 + 0.08 * L[Up.Swift];
  s.magnet = 90 * (1 + 0.35 * L[Up.Magnet]);
  s.regen = 0.6 * L[Up.Regen];
}

function cdTicks(s: SimState, base: number): number {
  return Math.floor(base * s.cdMul + 0.5);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ───────────────────────── 한 틱 진행 ─────────────────────────

export function step(s: SimState, inp: InputFrame): void {
  s.events.length = 0;
  if (s.phase === 'dead' || s.phase === 'won') return;

  // 레벨업 선택 중에는 월드가 멈추고, 선택 입력만 소비한다.
  if (s.phase === 'levelup') {
    if (inp.choice >= 0 && inp.choice < s.choices.length) {
      applyUpgrade(s, s.choices[inp.choice]);
      s.pendingLevels--;
      if (s.pendingLevels > 0) rollChoices(s);
      else s.phase = 'playing';
    }
    return;
  }

  s.tick++;
  updatePlayer(s, inp);
  spawnDirector(s);
  updateEnemies(s);
  buildGrid(s);
  separateEnemies(s);
  buildGrid(s);
  touchPlayer(s);
  fireWeapons(s);
  updateBullets(s);
  updateGems(s);
  removeDead(s);

  const p = s.player;
  // damageEnemy가 보스 처치 시 phase를 바꾸므로 타입 좁히기를 풀어서 비교한다.
  if ((s.phase as Phase) === 'won') {
    s.score += Math.floor(p.hp) * 20;
    if (s.emit) s.events.push({ t: 'win' });
  } else if (p.hp <= 0 || s.tick >= MAX_TICKS) {
    p.hp = 0;
    s.phase = 'dead';
    if (s.emit) s.events.push({ t: 'dead' });
  } else if (s.pendingLevels > 0) {
    rollChoices(s);
  }
}

// ───────────────────────── 플레이어 ─────────────────────────

function updatePlayer(s: SimState, inp: InputFrame): void {
  const p = s.player;
  p.px = p.x;
  p.py = p.y;
  let dx = inp.mx;
  let dy = inp.my;
  if (dx !== 0 && dy !== 0) {
    dx *= DIAG;
    dy *= DIAG;
  }
  if (dx !== 0 || dy !== 0) {
    p.fx = dx;
    p.fy = dy;
  }
  if (p.dashCd > 0) p.dashCd--;
  if (p.iframes > 0) p.iframes--;
  if (inp.dash && p.dashCd === 0 && p.dashT === 0) {
    p.dashT = DASH_TICKS;
    p.dashCd = DASH_CD;
    p.dashDx = p.fx;
    p.dashDy = p.fy;
    if (s.emit) s.events.push({ t: 'dash' });
  }
  let vx: number;
  let vy: number;
  if (p.dashT > 0) {
    p.dashT--;
    vx = p.dashDx * DASH_SPEED;
    vy = p.dashDy * DASH_SPEED;
  } else {
    const sp = PLAYER_SPEED * s.speedMul;
    vx = dx * sp;
    vy = dy * sp;
  }
  p.x = clamp(p.x + vx * DT, PLAYER_R, ARENA - PLAYER_R);
  p.y = clamp(p.y + vy * DT, PLAYER_R, ARENA - PLAYER_R);
  if (s.regen > 0 && p.hp < p.maxHp) {
    p.hp = Math.min(p.maxHp, p.hp + s.regen * DT);
  }
}

function hurtPlayer(s: SimState, dmg: number): void {
  const p = s.player;
  p.hp -= dmg;
  p.iframes = HIT_IFRAMES;
  if (s.emit) s.events.push({ t: 'playerHit', dmg });
}

// ───────────────────────── 스폰 ─────────────────────────

let tmpX = 0;
let tmpY = 0;

/** 단위원 안에서 기각 샘플링 후 정규화 → 삼각함수 없이 균등한 무작위 방향. */
function randDir(s: SimState): void {
  for (;;) {
    const x = nextFloat(s.rng) * 2 - 1;
    const y = nextFloat(s.rng) * 2 - 1;
    const d = x * x + y * y;
    if (d > 0.01 && d <= 1) {
      const l = Math.sqrt(d);
      tmpX = x / l;
      tmpY = y / l;
      return;
    }
  }
}

function spawnEnemy(s: SimState, kind: Kind, x: number, y: number, cap: number): Enemy | null {
  if (s.enemies.length >= cap) return null;
  const def = ENEMY_DEFS[kind];
  const scale = kind === Kind.Boss ? 1 : 1 + (s.tick * DT) / 100;
  const hp = def.hp * scale;
  x = clamp(x, def.r, ARENA - def.r);
  y = clamp(y, def.r, ARENA - def.r);
  const e: Enemy = {
    id: s.nextId++, kind, x, y, px: x, py: y, kx: 0, ky: 0,
    hp, maxHp: hp, r: def.r, speed: def.speed, dmg: def.dmg,
    cd: 90, cd2: 300, flash: 0, orbitCd: 0, mark: 0, dead: false,
  };
  s.enemies.push(e);
  return e;
}

function spawnAtRing(s: SimState, kind: Kind, cap: number): Enemy | null {
  const p = s.player;
  randDir(s);
  const dist = 720 + nextFloat(s.rng) * 120;
  let x = p.x + tmpX * dist;
  let y = p.y + tmpY * dist;
  // 벽에 막혀 화면 안에 나타나게 되면 반대편으로 보낸다.
  if (x < 0 || x > ARENA) x = p.x - tmpX * dist;
  if (y < 0 || y > ARENA) y = p.y - tmpY * dist;
  return spawnEnemy(s, kind, x, y, cap);
}

function pickKind(s: SimState, sec: number): Kind {
  const roll = nextFloat(s.rng);
  const tank = sec > 80 ? 0.1 : 0;
  const shooter = sec > 45 ? 0.14 : 0;
  const runner = sec > 15 ? 0.26 : 0;
  if (roll < tank) return Kind.Tank;
  if (roll < tank + shooter) return Kind.Shooter;
  if (roll < tank + shooter + runner) return Kind.Runner;
  return Kind.Chaser;
}

function spawnDirector(s: SimState): void {
  const sec = s.tick * DT;
  if (!s.bossSpawned && s.tick >= BOSS_TICK) {
    s.bossSpawned = true;
    const boss = spawnAtRing(s, Kind.Boss, MAX_ENEMIES);
    if (boss) {
      s.bossId = boss.id;
      boss.cd = 120;
    }
    if (s.emit) s.events.push({ t: 'bossSpawn' });
  }

  const rate = s.bossSpawned ? 2.5 : 1.1 + sec * 0.052;
  s.spawnAcc += rate * DT;
  while (s.spawnAcc >= 1) {
    s.spawnAcc -= 1;
    spawnAtRing(s, pickKind(s, sec), SOFT_CAP);
  }

  // 30초마다 포위 웨이브: 플레이어를 둘러싼 원형으로 16마리.
  if (!s.bossSpawned && s.tick % (30 * 60) === 0) {
    const p = s.player;
    randDir(s);
    let dx = tmpX;
    let dy = tmpY;
    for (let i = 0; i < 16; i++) {
      spawnEnemy(s, (i & 1) === 0 ? Kind.Chaser : Kind.Runner, p.x + dx * 560, p.y + dy * 560, SOFT_CAP);
      const nx = dx * ROT_22[0] - dy * ROT_22[1];
      dy = dx * ROT_22[1] + dy * ROT_22[0];
      dx = nx;
    }
    if (s.emit) s.events.push({ t: 'wave' });
  }
}

// ───────────────────────── 적 ─────────────────────────

function hostileBullet(s: SimState, x: number, y: number, dx: number, dy: number, speed: number, dmg: number): void {
  s.bullets.push({
    x, y, px: x, py: y, vx: dx * speed, vy: dy * speed,
    dmg, life: 240, pierce: 0, lastHit: -1, hostile: true,
  });
}

function updateEnemies(s: SimState): void {
  const p = s.player;
  const es = s.enemies;
  const n = es.length; // 루프 중 소환된 적은 다음 틱부터 움직인다.
  for (let i = 0; i < n; i++) {
    const e = es[i];
    e.px = e.x;
    e.py = e.y;
    if (e.flash > 0) e.flash--;
    if (e.orbitCd > 0) e.orbitCd--;

    let dx = p.x - e.x;
    let dy = p.y - e.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= d;
    dy /= d;
    let mx = dx;
    let my = dy;

    if (e.kind === Kind.Shooter) {
      // 거리를 유지하며 옆으로 돌면서 사격
      if (d < 220) {
        mx = -dx;
        my = -dy;
      } else if (d < 330) {
        const side = (e.id & 1) === 0 ? 1 : -1;
        mx = -dy * side;
        my = dx * side;
      }
      if (--e.cd <= 0 && d < 560) {
        e.cd = 130;
        hostileBullet(s, e.x, e.y, dx, dy, 210, e.dmg);
        if (s.emit) s.events.push({ t: 'enemyShoot', x: e.x, y: e.y });
      }
    } else if (e.kind === Kind.Boss) {
      const enraged = e.hp < e.maxHp * 0.5;
      if (--e.cd <= 0) {
        e.cd = enraged ? 95 : 150;
        // 16방향 탄막. 발사할 때마다 11.25도씩 어긋나게 해서 틈이 바뀐다.
        let bx = dx;
        let by = dy;
        if ((e.cd2 & 1) === 0) {
          const nx = bx * ROT_11[0] - by * ROT_11[1];
          by = bx * ROT_11[1] + by * ROT_11[0];
          bx = nx;
        }
        for (let k = 0; k < 16; k++) {
          hostileBullet(s, e.x, e.y, bx, by, enraged ? 230 : 190, 14);
          const nx = bx * ROT_22[0] - by * ROT_22[1];
          by = bx * ROT_22[1] + by * ROT_22[0];
          bx = nx;
        }
        if (s.emit) s.events.push({ t: 'enemyShoot', x: e.x, y: e.y });
      }
      if (--e.cd2 <= 0) {
        e.cd2 = 360;
        for (let k = 0; k < 5; k++) {
          randDir(s);
          spawnEnemy(s, Kind.Runner, e.x + tmpX * 70, e.y + tmpY * 70, MAX_ENEMIES - 1);
        }
      }
      if (enraged) {
        mx *= 1.35;
        my *= 1.35;
      }
    }

    e.x = clamp(e.x + (mx * e.speed + e.kx) * DT, e.r, ARENA - e.r);
    e.y = clamp(e.y + (my * e.speed + e.ky) * DT, e.r, ARENA - e.r);
    e.kx *= 0.86;
    e.ky *= 0.86;
  }
}

function cellCoord(v: number): number {
  const c = (v / CELL) | 0;
  return c < 0 ? 0 : c >= GW ? GW - 1 : c;
}

function buildGrid(s: SimState): void {
  const head = s.gridHead;
  const next = s.gridNext;
  head.fill(-1);
  const es = s.enemies;
  for (let i = 0; i < es.length; i++) {
    const c = cellCoord(es[i].y) * GW + cellCoord(es[i].x);
    next[i] = head[c];
    head[c] = i;
  }
}

/** 원과 겹치는 살아 있는 적의 인덱스를 s.scratch에 담고 개수를 반환. */
function query(s: SimState, x: number, y: number, r: number): number {
  const out = s.scratch;
  const es = s.enemies;
  const head = s.gridHead;
  const next = s.gridNext;
  const R = r + MAX_R;
  const x0 = cellCoord(x - R);
  const x1 = cellCoord(x + R);
  const y0 = cellCoord(y - R);
  const y1 = cellCoord(y + R);
  let n = 0;
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      for (let i = head[cy * GW + cx]; i !== -1; i = next[i]) {
        const e = es[i];
        if (e.dead) continue;
        const dx = e.x - x;
        const dy = e.y - y;
        const rr = r + e.r;
        if (dx * dx + dy * dy < rr * rr) out[n++] = i;
      }
    }
  }
  return n;
}

function pushApart(a: Enemy, b: Enemy): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const rr = a.r + b.r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= rr * rr || d2 === 0) return;
  const d = Math.sqrt(d2);
  const push = ((rr - d) * 0.25) / d;
  if (a.kind !== Kind.Boss) {
    a.x -= dx * push;
    a.y -= dy * push;
  }
  if (b.kind !== Kind.Boss) {
    b.x += dx * push;
    b.y += dy * push;
  }
}

/** 적끼리 겹치지 않게 민다. 같은 셀 + 절반 이웃(4칸)만 보면 모든 쌍을 한 번씩 처리한다. */
function separateEnemies(s: SimState): void {
  const es = s.enemies;
  const head = s.gridHead;
  const next = s.gridNext;
  for (let cy = 0; cy < GW; cy++) {
    for (let cx = 0; cx < GW; cx++) {
      for (let i = head[cy * GW + cx]; i !== -1; i = next[i]) {
        const a = es[i];
        for (let j = next[i]; j !== -1; j = next[j]) pushApart(a, es[j]);
        if (cx + 1 < GW) {
          for (let j = head[cy * GW + cx + 1]; j !== -1; j = next[j]) pushApart(a, es[j]);
        }
        if (cy + 1 < GW) {
          const row = (cy + 1) * GW;
          if (cx > 0) for (let j = head[row + cx - 1]; j !== -1; j = next[j]) pushApart(a, es[j]);
          for (let j = head[row + cx]; j !== -1; j = next[j]) pushApart(a, es[j]);
          if (cx + 1 < GW) for (let j = head[row + cx + 1]; j !== -1; j = next[j]) pushApart(a, es[j]);
        }
      }
    }
  }
  for (let i = 0; i < es.length; i++) {
    const e = es[i];
    e.x = clamp(e.x, e.r, ARENA - e.r);
    e.y = clamp(e.y, e.r, ARENA - e.r);
  }
}

function touchPlayer(s: SimState): void {
  const p = s.player;
  if (p.iframes > 0 || p.dashT > 0) return;
  const n = query(s, p.x, p.y, PLAYER_R - 3);
  if (n === 0) return;
  let dmg = 0;
  for (let i = 0; i < n; i++) {
    const e = s.enemies[s.scratch[i]];
    if (e.dmg > dmg) dmg = e.dmg;
  }
  hurtPlayer(s, dmg);
}

function damageEnemy(s: SimState, e: Enemy, dmg: number, kx: number, ky: number): void {
  if (e.dead) return;
  e.hp -= dmg;
  e.flash = 5;
  const kb = ENEMY_DEFS[e.kind].kb;
  e.kx += kx * kb;
  e.ky += ky * kb;
  if (s.emit) s.events.push({ t: 'hit', x: e.x, y: e.y, dmg });
  if (e.hp > 0) return;

  e.dead = true;
  s.kills++;
  const def = ENEMY_DEFS[e.kind];
  s.score += def.score;
  if (def.xp > 0) dropGem(s, e.x, e.y, def.xp);
  if (s.emit) s.events.push({ t: 'kill', x: e.x, y: e.y, kind: e.kind, r: e.r });
  if (e.kind === Kind.Boss) s.phase = 'won';
}

function removeDead(s: SimState): void {
  const es = s.enemies;
  let w = 0;
  for (let i = 0; i < es.length; i++) {
    if (!es[i].dead) es[w++] = es[i];
  }
  es.length = w;
}

// ───────────────────────── 무기 ─────────────────────────

function nearestEnemy(s: SimState, x: number, y: number, range: number, skipMark: number): Enemy | null {
  let best: Enemy | null = null;
  let bestD = range * range;
  const es = s.enemies;
  for (let i = 0; i < es.length; i++) {
    const e = es[i];
    if (e.dead || e.mark === skipMark) continue;
    const dx = e.x - x;
    const dy = e.y - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function playerBullet(s: SimState, dx: number, dy: number, dmg: number, pierce: number): void {
  const p = s.player;
  const l = Math.sqrt(dx * dx + dy * dy);
  s.bullets.push({
    x: p.x, y: p.y, px: p.x, py: p.y,
    vx: (dx / l) * BOLT.speed, vy: (dy / l) * BOLT.speed,
    dmg, life: BOLT.life, pierce, lastHit: -1, hostile: false,
  });
}

function fireWeapons(s: SimState): void {
  const p = s.player;
  const L = s.levels;

  // 불씨 탄환
  if (s.boltCd > 0) s.boltCd--;
  if (s.boltCd === 0) {
    const target = nearestEnemy(s, p.x, p.y, BOLT.range, -1);
    if (target) {
      const lv = L[Up.Bolt] - 1;
      s.boltCd = cdTicks(s, BOLT.cd[lv]);
      const dx = target.x - p.x;
      const dy = target.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / d;
      const uy = dy / d;
      const dmg = BOLT.dmg[lv] * s.dmgMul;
      const count = BOLT.count[lv];
      const pierce = BOLT.pierce[lv];
      // 부채꼴: 방향 벡터에 수직 성분을 더해서 만든다.
      if (count === 1) {
        playerBullet(s, ux, uy, dmg, pierce);
      } else if (count === 2) {
        playerBullet(s, ux - uy * 0.1, uy + ux * 0.1, dmg, pierce);
        playerBullet(s, ux + uy * 0.1, uy - ux * 0.1, dmg, pierce);
      } else {
        playerBullet(s, ux, uy, dmg, pierce);
        playerBullet(s, ux - uy * 0.2, uy + ux * 0.2, dmg, pierce);
        playerBullet(s, ux + uy * 0.2, uy - ux * 0.2, dmg, pierce);
      }
      if (s.emit) s.events.push({ t: 'shoot' });
    }
  }

  // 공전 칼날
  {
    const nx = s.orbX * ROT_ORBIT[0] - s.orbY * ROT_ORBIT[1];
    const ny = s.orbX * ROT_ORBIT[1] + s.orbY * ROT_ORBIT[0];
    const l = Math.sqrt(nx * nx + ny * ny); // 누적 오차로 길이가 변하지 않게 재정규화
    s.orbX = nx / l;
    s.orbY = ny / l;
  }
  if (L[Up.Orbit] > 0) {
    const lv = L[Up.Orbit] - 1;
    const blades = ORBIT.blades[lv];
    const radius = ORBIT.radius[lv];
    const dmg = ORBIT.dmg[lv] * s.dmgMul;
    let bx = s.orbX;
    let by = s.orbY;
    for (let k = 0; k < blades; k++) {
      const n = query(s, p.x + bx * radius, p.y + by * radius, ORBIT.bladeR);
      for (let i = 0; i < n; i++) {
        const e = s.enemies[s.scratch[i]];
        if (e.orbitCd > 0) continue;
        e.orbitCd = ORBIT.hitCd;
        damageEnemy(s, e, dmg, bx * 160, by * 160);
      }
      const nb = orbitNext(bx, by, blades);
      bx = nb[0];
      by = nb[1];
    }
  }

  // 섬광 파동
  if (L[Up.Nova] > 0) {
    if (s.novaCd > 0) s.novaCd--;
    if (s.novaCd === 0) {
      const lv = L[Up.Nova] - 1;
      s.novaCd = cdTicks(s, NOVA.cd[lv]);
      const r = NOVA.radius[lv];
      const dmg = NOVA.dmg[lv] * s.dmgMul;
      const n = query(s, p.x, p.y, r);
      for (let i = 0; i < n; i++) {
        const e = s.enemies[s.scratch[i]];
        const dx = e.x - p.x;
        const dy = e.y - p.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        damageEnemy(s, e, dmg, (dx / d) * NOVA.kb, (dy / d) * NOVA.kb);
      }
      if (s.emit) s.events.push({ t: 'nova', x: p.x, y: p.y, r });
    }
  }

  // 연쇄 번개
  if (L[Up.Chain] > 0) {
    if (s.chainCd > 0) s.chainCd--;
    if (s.chainCd === 0) {
      const lv = L[Up.Chain] - 1;
      const mark = ++s.markSeq;
      let cur = nearestEnemy(s, p.x, p.y, CHAIN.range, mark);
      if (cur) {
        s.chainCd = cdTicks(s, CHAIN.cd[lv]);
        const dmg = CHAIN.dmg[lv] * s.dmgMul;
        const pts: number[] | null = s.emit ? [p.x, p.y] : null;
        let hops = CHAIN.jumps[lv] + 1;
        while (cur && hops-- > 0) {
          cur.mark = mark;
          if (pts) pts.push(cur.x, cur.y);
          const cx = cur.x;
          const cy = cur.y;
          damageEnemy(s, cur, dmg, 0, 0);
          cur = nearestEnemy(s, cx, cy, CHAIN.jumpRange, mark);
        }
        if (pts) s.events.push({ t: 'chain', pts });
      }
    }
  }
}

const orbTmp: [number, number] = [0, 0];
/** 칼날 N개를 균등 배치하기 위한 다음 칼날 방향 (360/N도 회전). */
function orbitNext(x: number, y: number, blades: number): [number, number] {
  if (blades === 2) {
    orbTmp[0] = -x;
    orbTmp[1] = -y;
  } else if (blades === 3) {
    orbTmp[0] = x * ROT_120[0] - y * ROT_120[1];
    orbTmp[1] = x * ROT_120[1] + y * ROT_120[0];
  } else {
    orbTmp[0] = -y;
    orbTmp[1] = x;
  }
  return orbTmp;
}

/** 렌더러가 칼날 위치를 그릴 때 쓰는 헬퍼 (시뮬레이션과 같은 계산). */
export function orbitBlades(s: SimState, out: number[]): number {
  const lv = s.levels[Up.Orbit];
  if (lv === 0) return 0;
  const blades = ORBIT.blades[lv - 1];
  let bx = s.orbX;
  let by = s.orbY;
  for (let k = 0; k < blades; k++) {
    out[k * 2] = bx;
    out[k * 2 + 1] = by;
    const nb = orbitNext(bx, by, blades);
    bx = nb[0];
    by = nb[1];
  }
  return blades;
}

// ───────────────────────── 탄환 / 경험치 ─────────────────────────

function updateBullets(s: SimState): void {
  const p = s.player;
  const bs = s.bullets;
  let w = 0;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    b.px = b.x;
    b.py = b.y;
    b.x += b.vx * DT;
    b.y += b.vy * DT;
    let alive = --b.life > 0 && b.x > 0 && b.x < ARENA && b.y > 0 && b.y < ARENA;
    if (alive && b.hostile) {
      const dx = b.x - p.x;
      const dy = b.y - p.y;
      const rr = PLAYER_R + 4;
      if (dx * dx + dy * dy < rr * rr && p.dashT === 0) {
        if (p.iframes === 0) hurtPlayer(s, b.dmg);
        alive = false;
      }
    } else if (alive) {
      const n = query(s, b.x, b.y, 5);
      for (let k = 0; k < n; k++) {
        const e = s.enemies[s.scratch[k]];
        if (e.id === b.lastHit) continue;
        b.lastHit = e.id;
        damageEnemy(s, e, b.dmg, b.vx * 0.22, b.vy * 0.22);
        if (b.pierce-- <= 0) alive = false;
        break;
      }
    }
    if (alive) bs[w++] = b;
  }
  bs.length = w;
}

function dropGem(s: SimState, x: number, y: number, value: number): void {
  if (s.gems.length >= MAX_GEMS) {
    // 상한을 넘으면 새로 만들지 않고 가장 오래된 보석에 합친다.
    s.gems[0].value += value;
    return;
  }
  s.gems.push({ x, y, px: x, py: y, value, pulled: false });
}

function updateGems(s: SimState): void {
  const p = s.player;
  const gs = s.gems;
  const mag2 = s.magnet * s.magnet;
  let w = 0;
  for (let i = 0; i < gs.length; i++) {
    const g = gs[i];
    g.px = g.x;
    g.py = g.y;
    const dx = p.x - g.x;
    const dy = p.y - g.y;
    const d2 = dx * dx + dy * dy;
    if (!g.pulled && d2 < mag2) g.pulled = true;
    if (g.pulled) {
      if (d2 < 22 * 22) {
        gainXp(s, g.value);
        continue;
      }
      const d = Math.sqrt(d2);
      g.x += (dx / d) * 560 * DT;
      g.y += (dy / d) * 560 * DT;
    }
    gs[w++] = g;
  }
  gs.length = w;
}

function gainXp(s: SimState, value: number): void {
  const p = s.player;
  p.xp += value;
  if (s.emit) s.events.push({ t: 'gem' });
  while (p.xp >= p.xpNext) {
    p.xp -= p.xpNext;
    p.level++;
    p.xpNext = xpForLevel(p.level);
    s.pendingLevels++;
  }
}

// ───────────────────────── 레벨업 ─────────────────────────

function rollChoices(s: SimState): void {
  const pool: number[] = [];
  for (let i = 0; i < UPGRADE_COUNT; i++) {
    if (s.levels[i] < UPGRADE_MAX) pool.push(i);
  }
  if (pool.length === 0) {
    // 전부 최대 레벨이면 선택 없이 회복으로 대체
    s.player.hp = Math.min(s.player.maxHp, s.player.hp + 15 * s.pendingLevels);
    s.pendingLevels = 0;
    return;
  }
  const k = Math.min(3, pool.length);
  for (let i = 0; i < k; i++) {
    const j = i + nextInt(s.rng, pool.length - i);
    const t = pool[i];
    pool[i] = pool[j];
    pool[j] = t;
  }
  pool.length = k;
  s.choices = pool;
  s.phase = 'levelup';
  if (s.emit) s.events.push({ t: 'levelup' });
}

function applyUpgrade(s: SimState, idx: number): void {
  s.levels[idx]++;
  if (idx === Up.Vital) {
    s.player.maxHp += 20;
    s.player.hp = Math.min(s.player.maxHp, s.player.hp + 20);
  }
  recomputeStats(s);
}

// ───────────────────────── 결과 / 체크섬 ─────────────────────────

export interface RunResult {
  score: number;
  kills: number;
  ticks: number;
  level: number;
  won: boolean;
  finished: boolean;
  checksum: number;
}

/** 상태 요약 해시(FNV-1a). 클라이언트와 서버의 시뮬레이션이 어긋났는지 확인하는 데 쓴다. */
export function checksum(s: SimState): number {
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    h = Math.imul(h ^ (v | 0), 0x01000193);
  };
  mix(s.tick);
  mix(s.score);
  mix(s.kills);
  mix(s.player.level);
  mix(Math.floor(s.player.hp * 1000));
  mix(Math.floor(s.player.x * 1000));
  mix(Math.floor(s.player.y * 1000));
  mix(s.enemies.length);
  mix(s.rng.s);
  return h >>> 0;
}

export function resultOf(s: SimState): RunResult {
  return {
    score: s.score,
    kills: s.kills,
    ticks: s.tick,
    level: s.player.level,
    won: s.phase === 'won',
    finished: s.phase === 'won' || s.phase === 'dead',
    checksum: checksum(s),
  };
}
