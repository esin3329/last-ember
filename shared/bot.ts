// 자동 플레이 봇. 세 군데에서 쓴다.
//  - 테스트: 실제 플레이와 비슷한 입력 로그를 만들어 결정론/서버 검증을 시험
//  - 밸런스 스크립트: 수백 판을 헤드리스로 돌려 난이도 곡선 확인
//  - 메뉴 화면 배경 데모
// 시뮬레이션 상태만 읽고 입력을 만들 뿐이라 검증 규칙(결정론)과는 무관하다.

import type { InputFrame } from './input.ts';
import { ARENA, BOMBER, Kind, Up } from './defs.ts';
import type { SimState } from './sim.ts';

// 봇이 선호하는 업그레이드 순서 (진화는 나오면 항상 먼저)
const PRIORITY: number[] = [
  Up.SunLance, Up.Tempest, Up.Bloom, Up.Thunder,
  Up.Orbit, Up.Bolt, Up.Nova, Up.Chain, Up.Might, Up.Haste, Up.Vital, Up.Swift, Up.Regen, Up.Magnet,
];

export function botInput(s: SimState, out: InputFrame): InputFrame {
  out.mx = 0;
  out.my = 0;
  out.dash = false;
  out.choice = -1;

  if (s.phase === 'levelup') {
    let best = 0;
    let bestRank = 99;
    for (let i = 0; i < s.choices.length; i++) {
      const rank = PRIORITY.indexOf(s.choices[i]);
      if (rank < bestRank) {
        bestRank = rank;
        best = i;
      }
    }
    out.choice = best;
    return out;
  }

  const p = s.player;
  let vx = 0;
  let vy = 0;
  let danger = false;

  // 가까운 적에게서 멀어지는 힘 (거리 제곱에 반비례)
  for (const e of s.enemies) {
    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const d2 = dx * dx + dy * dy;
    // 점화한 자폭병과 돌진 준비 중인 보스는 더 넓게 피한다
    const fusing = e.kind === Kind.Bomber && e.mode === 1;
    const charging = e.kind === Kind.Boss && e.mode !== 0;
    const reach = fusing ? BOMBER.radius + 70 : charging ? 420 : e.elite ? 300 : 190 + e.r * 2;
    if (d2 > reach * reach) continue;
    const w = (fusing ? 40000 : charging ? 30000 : e.elite ? 20000 : 9000) / (d2 + 60);
    vx += dx * w;
    vy += dy * w;
    if (d2 < (e.r + 30) * (e.r + 30)) danger = true;
    if (fusing && e.timer < 12 && d2 < (BOMBER.radius + 14) * (BOMBER.radius + 14)) danger = true;
    if (charging && e.mode === 2 && d2 < 160 * 160) danger = true;
  }
  // 적 탄환 회피
  for (const b of s.bullets) {
    if (!b.hostile) continue;
    const dx = p.x - b.x;
    const dy = p.y - b.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > 130 * 130) continue;
    const w = 14000 / (d2 + 60);
    vx += dx * w;
    vy += dy * w;
    if (d2 < 34 * 34) danger = true;
  }
  // 보물 상자가 있으면 강하게, 없으면 가장 가까운 경험치 쪽으로 약하게 끌림
  let gd = 420 * 420;
  let gx = 0;
  let gy = 0;
  let pull = 180;
  for (const c of s.chests) {
    const dx = c.x - p.x;
    const dy = c.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 1200 * 1200 && (pull === 180 || d2 < gd)) {
      gd = d2;
      gx = dx;
      gy = dy;
      pull = 420;
    }
  }
  if (pull === 180) {
    for (const g of s.gems) {
      const dx = g.x - p.x;
      const dy = g.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < gd) {
        gd = d2;
        gx = dx;
        gy = dy;
      }
    }
  }
  if (gx !== 0 || gy !== 0) {
    const d = Math.sqrt(gd);
    vx += (gx / d) * pull;
    vy += (gy / d) * pull;
  }
  // 벽에 몰리지 않게 중앙으로
  const cx = ARENA / 2 - p.x;
  const cy = ARENA / 2 - p.y;
  const edge = 320;
  if (p.x < edge || p.x > ARENA - edge) vx += cx * 1.6;
  if (p.y < edge || p.y > ARENA - edge) vy += cy * 1.6;

  const len = Math.sqrt(vx * vx + vy * vy);
  if (len > 20) {
    if (Math.abs(vx) > len * 0.38) out.mx = vx > 0 ? 1 : -1;
    if (Math.abs(vy) > len * 0.38) out.my = vy > 0 ? 1 : -1;
  }
  out.dash = danger && p.dashCd === 0;
  return out;
}
