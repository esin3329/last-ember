// 데이터 테이블. 수치 조정은 이 파일만 고치면 된다.
// 주의: 값을 바꾸면 기존 리플레이와 호환되지 않으므로 SIM_VERSION을 올려야 한다.

export const SIM_VERSION = 1;

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const ARENA = 2400;
export const BOSS_TICK = 180 * TICK_RATE;
export const MAX_TICKS = 600 * TICK_RATE;

export const PLAYER_R = 12;
export const PLAYER_SPEED = 230;
export const PLAYER_HP = 100;
export const DASH_TICKS = 11;
export const DASH_CD = 80;
export const DASH_SPEED = 760;
export const HIT_IFRAMES = 40;

export const Kind = { Chaser: 0, Runner: 1, Tank: 2, Shooter: 3, Boss: 4 } as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

export interface EnemyDef {
  hp: number;
  speed: number;
  dmg: number;
  r: number;
  xp: number;
  score: number;
  kb: number; // 넉백 계수 (0이면 밀리지 않음)
}

export const ENEMY_DEFS: readonly EnemyDef[] = [
  { hp: 12, speed: 92, dmg: 9, r: 11, xp: 1, score: 10, kb: 1 }, // Chaser
  { hp: 7, speed: 168, dmg: 7, r: 8, xp: 1, score: 12, kb: 1.2 }, // Runner
  { hp: 70, speed: 56, dmg: 18, r: 20, xp: 6, score: 60, kb: 0.35 }, // Tank
  { hp: 20, speed: 78, dmg: 8, r: 12, xp: 3, score: 30, kb: 1 }, // Shooter
  { hp: 4200, speed: 84, dmg: 26, r: 44, xp: 0, score: 5000, kb: 0 }, // Boss
];

export const Up = {
  Bolt: 0,
  Orbit: 1,
  Nova: 2,
  Chain: 3,
  Might: 4,
  Haste: 5,
  Swift: 6,
  Vital: 7,
  Magnet: 8,
  Regen: 9,
} as const;

export const UPGRADE_COUNT = 10;
export const UPGRADE_MAX = 5;

// 무기 레벨별 수치 (인덱스 = 레벨 - 1)
export const BOLT = {
  cd: [26, 23, 21, 19, 16],
  count: [1, 1, 2, 2, 3],
  dmg: [10, 14, 15, 19, 23],
  pierce: [0, 0, 0, 1, 2],
  speed: 540,
  range: 480,
  life: 60,
};
export const ORBIT = {
  blades: [2, 2, 3, 3, 4],
  dmg: [9, 13, 14, 18, 22],
  radius: [72, 78, 78, 86, 92],
  hitCd: 22,
  bladeR: 15,
};
export const NOVA = {
  cd: [170, 155, 140, 128, 112],
  radius: [120, 135, 150, 168, 190],
  dmg: [18, 25, 32, 40, 50],
  kb: 300,
};
export const CHAIN = {
  cd: [96, 90, 84, 76, 68],
  jumps: [3, 4, 5, 6, 8],
  dmg: [15, 19, 23, 28, 34],
  range: 380,
  jumpRange: 175,
};

export interface UpgradeMeta {
  name: string;
  icon: string;
  color: string;
  weapon: boolean;
  desc: (nextLevel: number) => string;
}

export const UPGRADE_META: readonly UpgradeMeta[] = [
  {
    name: '불씨 탄환', icon: '✦', color: '#ffb347', weapon: true,
    desc: (l) => `가장 가까운 적에게 탄환 ${BOLT.count[l - 1]}발 · 피해 ${BOLT.dmg[l - 1]}` + (BOLT.pierce[l - 1] ? ` · 관통 ${BOLT.pierce[l - 1]}` : ''),
  },
  {
    name: '공전 칼날', icon: '◐', color: '#7fe3ff', weapon: true,
    desc: (l) => `주위를 도는 칼날 ${ORBIT.blades[l - 1]}개 · 피해 ${ORBIT.dmg[l - 1]}`,
  },
  {
    name: '섬광 파동', icon: '◎', color: '#c79bff', weapon: true,
    desc: (l) => `주기적으로 주변을 폭발 · 피해 ${NOVA.dmg[l - 1]} · 범위 ${NOVA.radius[l - 1]}`,
  },
  {
    name: '연쇄 번개', icon: 'ϟ', color: '#fff27a', weapon: true,
    desc: (l) => `적 ${CHAIN.jumps[l - 1] + 1}명에게 튀는 번개 · 피해 ${CHAIN.dmg[l - 1]}`,
  },
  { name: '화력', icon: '▲', color: '#ff7a6b', weapon: false, desc: (l) => `모든 피해 +${l * 12}%` },
  { name: '가속', icon: '»', color: '#8dffb0', weapon: false, desc: (l) => `무기 재사용 대기 -${l * 8}%` },
  { name: '신속', icon: '➤', color: '#9ad0ff', weapon: false, desc: (l) => `이동 속도 +${l * 8}%` },
  { name: '생명력', icon: '♥', color: '#ff6f91', weapon: false, desc: () => `최대 체력 +20, 체력 20 회복` },
  { name: '자력', icon: '◈', color: '#6ff0d0', weapon: false, desc: (l) => `경험치 흡수 범위 +${l * 35}%` },
  { name: '재생', icon: '✚', color: '#b6ff7a', weapon: false, desc: (l) => `초당 체력 ${(l * 0.6).toFixed(1)} 회복` },
];
