import { ARENA, Kind } from '../../shared/defs.ts';
import type { InputFrame } from '../../shared/input.ts';
import { createSim, spawnEnemy, step } from '../../shared/sim.ts';

const MOVE_DISTANCE = 40;

export class Tutorial {
  readonly sim = createSim(1);
  stage: 'move' | 'dash' | 'attack' | 'collect' | 'upgrade' | 'complete' = 'move';

  step(input: InputFrame): void {
    if (this.stage === 'complete') return;
    const s = this.sim;
    const p = s.player;
    // 이동을 익히기 전에는 대시로 이동 과제를 건너뛸 수 없다.
    if (this.stage === 'move') input.dash = false;
    step(s, input, true);
    switch (this.stage) {
      case 'move': {
        const dx = p.x - ARENA / 2;
        const dy = p.y - ARENA / 2;
        if (dx * dx + dy * dy >= MOVE_DISTANCE * MOVE_DISTANCE) this.stage = 'dash';
        break;
      }
      case 'dash':
        if (s.events.some((e) => e.t === 'dash')) {
          const x = p.x + (p.x <= ARENA / 2 ? 180 : -180);
          const enemy = spawnEnemy(s, Kind.Chaser, x, p.y, 1);
          if (enemy) enemy.dmg = 0;
          this.stage = 'attack';
        }
        break;
      case 'attack':
        if (s.kills > 0) {
          const x = p.x + (p.x <= ARENA / 2 ? 150 : -150);
          // 불씨 하나로 실제 경험치·강화 선택 흐름을 익힐 수 있도록 한다.
          s.gems.push({ x, y: p.y, px: x, py: p.y, value: p.xpNext - p.xp, pulled: false });
          this.stage = 'collect';
        }
        break;
      case 'collect':
        if (s.phase === 'levelup') this.stage = 'upgrade';
        break;
      case 'upgrade':
        if (s.phase === 'playing') this.stage = 'complete';
        break;
    }
  }
}
