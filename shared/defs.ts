// 데이터 테이블. 수치 조정은 이 파일만 고치면 된다.
// 주의: 값을 바꾸면 기존 리플레이와 호환되지 않으므로 SIM_VERSION을 올려야 한다.

export const SIM_VERSION = 2;

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

export const Kind = { Chaser: 0, Runner: 1, Tank: 2, Shooter: 3, Boss: 4, Bomber: 5 } as const;
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
  { hp: 5600, speed: 84, dmg: 26, r: 44, xp: 0, score: 5000, kb: 0 }, // Boss
  { hp: 16, speed: 122, dmg: 6, r: 12, xp: 2, score: 25, kb: 1.1 }, // Bomber
];

// 자폭병: 가까이 오면 멈춰서 도화선을 태우고 폭발한다. 먼저 잡으면 폭발이 적에게만 피해를 준다.
export const BOMBER = {
  trigger: 78, // 이 거리 안에 들어오면 점화
  fuse: 50, // 점화 후 폭발까지 틱 (경고 시간)
  radius: 92,
  dmgPlayer: 24,
  dmgEnemy: 45, // 플레이어가 처치했을 때는 화력 배율을 받는다
};

// 엘리트: 보스 전까지 45초마다 나오는 강화 탱크. 처치하면 보물 상자(추가 선택 1회)를 떨군다.
export const ELITE = {
  every: 45 * TICK_RATE,
  hpMul: 4,
  rMul: 1.45,
  speedMul: 1.2,
  dmgMul: 1,
  kbMul: 0.3,
  xpMul: 3,
  score: 600,
  pickR: 30,
};

// 보스 2페이즈(체력 50% 이하): 조준 → 돌진 패턴이 추가된다.
export const BOSS_CHARGE = {
  cd: 300,
  windup: 54, // 예고 시간. 마지막 lock 틱 동안은 조준이 고정된다
  lock: 20,
  dash: 36,
  speed: 600,
};

// 보스는 폭발(자폭병·태양창) 피해를 일부만 받는다. 소환수 무리에 터지는 연쇄 폭발로 보스가 순식간에 녹는 것을 막는다.
export const BOSS_BLAST_MUL = 0.25;

// 무피격 연속 처치 배율: 40킬마다 0.5배씩, 최대 3배. 맞으면 초기화.
export const COMBO = { step: 40, maxTier: 4 };

export function comboTier(combo: number): number {
  const t = Math.floor(combo / COMBO.step);
  return t > COMBO.maxTier ? COMBO.maxTier : t;
}

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
  // 진화 (무기 MAX + 짝 패시브 Lv2 이상일 때만 선택지에 나온다)
  SunLance: 10,
  Tempest: 11,
  Bloom: 12,
  Thunder: 13,
} as const;

export const BASE_UPGRADES = 10;
export const UPGRADE_COUNT = 14;
export const UPGRADE_MAX = 5;
export const EVO_PASSIVE_LV = 2;

export function maxLevel(up: number): number {
  return up >= BASE_UPGRADES ? 1 : UPGRADE_MAX;
}

export interface Evolution {
  evo: number;
  weapon: number;
  passive: number;
}

export const EVOLUTIONS: readonly Evolution[] = [
  { evo: Up.SunLance, weapon: Up.Bolt, passive: Up.Might },
  { evo: Up.Tempest, weapon: Up.Orbit, passive: Up.Swift },
  { evo: Up.Bloom, weapon: Up.Nova, passive: Up.Vital },
  { evo: Up.Thunder, weapon: Up.Chain, passive: Up.Haste },
];

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

// 진화 무기
export const SUNLANCE = { dmgMul: 1.25, pierceAdd: 2, blastR: 64, blastMul: 0.6 };
export const TEMPEST = { blades: 6, radius: 108, dmgMul: 1.25, eraseR: 24 };
export const BLOOM = { radiusMul: 1.25, healPerHit: 0.8, healMax: 14 };
export const THUNDER = { jumps: 12, dmgMul: 1.2, cdMul: 0.8, stun: 36 };

export interface UpgradeMeta {
  name: string;
  icon: string;
  color: string;
  weapon: boolean;
  evo: boolean;
  desc: (nextLevel: number) => string;
}

export const UPGRADE_META: readonly UpgradeMeta[] = [
  {
    name: '불씨 탄환', icon: '✦', color: '#ffb347', weapon: true, evo: false,
    desc: (l) => `가장 가까운 적에게 탄환 ${BOLT.count[l - 1]}발 · 피해 ${BOLT.dmg[l - 1]}` + (BOLT.pierce[l - 1] ? ` · 관통 ${BOLT.pierce[l - 1]}` : ''),
  },
  {
    name: '공전 칼날', icon: '◐', color: '#7fe3ff', weapon: true, evo: false,
    desc: (l) => `주위를 도는 칼날 ${ORBIT.blades[l - 1]}개 · 피해 ${ORBIT.dmg[l - 1]}`,
  },
  {
    name: '섬광 파동', icon: '◎', color: '#c79bff', weapon: true, evo: false,
    desc: (l) => `주기적으로 주변을 폭발 · 피해 ${NOVA.dmg[l - 1]} · 범위 ${NOVA.radius[l - 1]}`,
  },
  {
    name: '연쇄 번개', icon: 'ϟ', color: '#fff27a', weapon: true, evo: false,
    desc: (l) => `적 ${CHAIN.jumps[l - 1] + 1}명에게 튀는 번개 · 피해 ${CHAIN.dmg[l - 1]}`,
  },
  { name: '화력', icon: '▲', color: '#ff7a6b', weapon: false, evo: false, desc: (l) => `모든 피해 +${l * 12}%` },
  { name: '가속', icon: '»', color: '#8dffb0', weapon: false, evo: false, desc: (l) => `무기 재사용 대기 -${l * 8}%` },
  { name: '신속', icon: '➤', color: '#9ad0ff', weapon: false, evo: false, desc: (l) => `이동 속도 +${l * 8}%` },
  { name: '생명력', icon: '♥', color: '#ff6f91', weapon: false, evo: false, desc: () => `최대 체력 +20, 체력 20 회복` },
  { name: '자력', icon: '◈', color: '#6ff0d0', weapon: false, evo: false, desc: (l) => `경험치 흡수 범위 +${l * 35}%` },
  { name: '재생', icon: '✚', color: '#b6ff7a', weapon: false, evo: false, desc: (l) => `초당 체력 ${(l * 0.6).toFixed(1)} 회복` },
  {
    name: '태양창', icon: '✹', color: '#ffd23f', weapon: true, evo: true,
    desc: () => `불씨 탄환 진화 · 피해 +25% · 관통 +2 · 명중 시 폭발(범위 ${SUNLANCE.blastR})`,
  },
  {
    name: '폭풍 고리', icon: '❂', color: '#4fd9ff', weapon: true, evo: true,
    desc: () => `공전 칼날 진화 · 칼날 ${TEMPEST.blades}개 · 반경 확대 · 적 탄환을 지운다`,
  },
  {
    name: '생명 파동', icon: '❀', color: '#7dffa8', weapon: true, evo: true,
    desc: () => `섬광 파동 진화 · 범위 +25% · 맞힌 적 하나당 체력 ${BLOOM.healPerHit} 회복`,
  },
  {
    name: '뇌신', icon: '☇', color: '#fff7b0', weapon: true, evo: true,
    desc: () => `연쇄 번개 진화 · 적 ${THUNDER.jumps + 1}명 · 맞은 적은 잠시 마비`,
  },
];
