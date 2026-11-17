// 게임 설계 규칙 테스트: 진화, 자폭병 연쇄, 콤보 배율, 엘리트 상자, 보스 돌진.
// 상태를 직접 꾸며 놓고 몇 틱 돌려서 규칙대로 결과가 나오는지 본다.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOMBER, BOSS_CHARGE, ENEMY_DEFS, Kind, PLAYER_HP, Up, comboTier } from '../defs.ts';
import type { InputFrame } from '../input.ts';
import { type Enemy, type SimState, canEvolve, createSim, step } from '../sim.ts';

const idle: InputFrame = { mx: 0, my: 0, dash: false, choice: -1 };

function put(s: SimState, kind: Kind, dx: number, dy: number, over: Partial<Enemy> = {}): Enemy {
  const d = ENEMY_DEFS[kind];
  const x = s.player.x + dx;
  const y = s.player.y + dy;
  const e: Enemy = {
    id: s.nextId++, kind, x, y, px: x, py: y, kx: 0, ky: 0,
    hp: d.hp, maxHp: d.hp, r: d.r, speed: d.speed, dmg: d.dmg,
    cd: 90, cd2: 300, flash: 0, orbitCd: 0, mark: 0,
    elite: false, stun: 0, mode: 0, timer: 0, ax: 0, ay: 0, dead: false,
    ...over,
  };
  s.enemies.push(e);
  return e;
}

function run(s: SimState, ticks: number): void {
  for (let i = 0; i < ticks && s.phase === 'playing'; i++) step(s, idle);
}

test('진화는 무기 MAX + 짝 패시브 Lv2일 때만, 선택지 맨 앞에 나온다', () => {
  const s = createSim(1);
  s.levels[Up.Bolt] = 5;
  s.levels[Up.Might] = 1;
  assert.equal(canEvolve(s.levels, Up.SunLance), false);
  s.levels[Up.Might] = 2;
  assert.equal(canEvolve(s.levels, Up.SunLance), true);

  s.pendingLevels = 1;
  step(s, idle);
  assert.equal(s.phase, 'levelup');
  assert.equal(s.choices[0], Up.SunLance);
  assert.equal(s.choices.length, 3);

  step(s, { ...idle, choice: 0 });
  assert.equal(s.levels[Up.SunLance], 1);
  assert.equal(canEvolve(s.levels, Up.SunLance), false); // 한 번만
});

test('먼저 잡은 자폭병은 주변 적만 날리고 플레이어는 다치지 않는다', () => {
  const s = createSim(2);
  s.boltCd = 1;
  put(s, Kind.Bomber, 200, 0, { hp: 1 });
  put(s, Kind.Chaser, 240, 0);
  put(s, Kind.Chaser, 220, 30);
  run(s, 40);
  assert.equal(s.kills, 3, '자폭병 + 폭발에 휘말린 적 2');
  assert.equal(s.player.hp, PLAYER_HP);
});

test('점화한 자폭병을 놓치면 폭발 피해를 입고 콤보가 끊긴다', () => {
  const s = createSim(3);
  s.boltCd = 1e9; // 무기를 꺼서 자폭병을 못 잡게 한다
  s.combo = 50;
  put(s, Kind.Bomber, 60, 0);
  run(s, BOMBER.fuse + 2);
  assert.equal(s.kills, 0, '자폭은 처치로 치지 않는다');
  assert.equal(s.player.hp, PLAYER_HP - BOMBER.dmgPlayer);
  assert.equal(s.combo, 0);
});

test('콤보 단계마다 처치 점수가 0.5배씩 오른다', () => {
  assert.deepEqual([0, 39, 40, 80, 159, 160, 999].map(comboTier), [0, 0, 1, 2, 3, 4, 4]);
  const s = createSim(4);
  s.boltCd = 1;
  s.combo = 80; // 2단계 → 2배
  put(s, Kind.Chaser, 100, 0, { hp: 0.01 });
  run(s, 30);
  assert.equal(s.kills, 1);
  assert.equal(s.score, ENEMY_DEFS[Kind.Chaser].score * 2);
  assert.equal(s.combo, 81);
});

test('엘리트는 상자를 떨구고, 상자를 주우면 추가 선택이 열린다', () => {
  const s = createSim(5);
  s.boltCd = 1;
  put(s, Kind.Tank, 120, 0, { hp: 0.01, elite: true });
  run(s, 30);
  assert.equal(s.chests.length, 1);
  // 상자를 플레이어 위치로 옮기면 다음 틱에 획득
  s.chests[0].x = s.player.x;
  s.chests[0].y = s.player.y;
  run(s, 1);
  assert.equal(s.chests.length, 0);
  assert.equal(s.phase, 'levelup');
});

test('체력 50% 이하 보스는 예고 후 고정된 방향으로 돌진한다', () => {
  const s = createSim(6);
  s.boltCd = 1e9;
  const boss = put(s, Kind.Boss, 500, 0, { hp: 100, maxHp: 1000, timer: 1, cd: 1e9, cd2: 1e9 });
  run(s, 1);
  assert.equal(boss.mode, 1, '조준 시작');
  const x0 = boss.x;
  run(s, BOSS_CHARGE.windup - 1);
  assert.equal(boss.x, x0, '조준 중에는 멈춰 있다');
  run(s, 1);
  assert.equal(boss.mode, 2, '돌진 시작');
  const before = boss.x;
  run(s, 1);
  assert.ok(before - boss.x > 9, '돌진 속도로 플레이어 쪽(-x)으로 이동');
});
