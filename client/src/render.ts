// Canvas 2D 렌더러.
// 시뮬레이션은 60Hz 고정이고 화면 주사율은 제각각이므로, 이전 틱 위치(px, py)와
// 현재 위치를 alpha로 보간해서 그린다. 그리는 쪽은 상태를 읽기만 한다.
//
// 드로우 콜을 줄이기 위해 적은 종류별로 한 경로(Path)에 모아 한 번에 채우고,
// 화면 밖 개체는 그리지 않는다.

import { ARENA, BOMBER, BOSS_CHARGE, DT, Kind, PLAYER_R, Up } from '../../shared/defs.ts';
import { type SimState, orbitBlades, orbitRadius } from '../../shared/sim.ts';
import bossUrl from '../assets/sprites/runtime/abyssal-core.png';
import bomberUrl from '../assets/sprites/runtime/bomber.png';
import playerUrl from '../assets/sprites/runtime/player-ember-v2.png';
import chaserUrl from '../assets/sprites/runtime/chaser.png';
import runnerUrl from '../assets/sprites/runtime/runner.png';
import tankUrl from '../assets/sprites/runtime/tank.png';
import shooterUrl from '../assets/sprites/runtime/shooter.png';
import floorUrl from '../assets/environment/runtime/arena-floor.png';
import type { Fx } from './fx.ts';

const KIND_COLOR = ['#ff5d73', '#ffa24d', '#b388ff', '#4de2c5', '#ff4fd8', '#ffe14d'];
const ELITE_COLOR = '#ffd23f';
const PLAYER_SPRITE_SIZE = PLAYER_R * 4.7;
const PLAYER_SPRITE_PIVOT = 0.605;
export const kindColor = (k: number): string => KIND_COLOR[k];

function polygon(n: number, inner = 1): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = i % 2 === 1 ? inner : 1;
    out.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  return out;
}

// 반지름 1 기준의 로컬 좌표 다각형
const SHAPES: number[][] = [
  [1.35, 0, -0.9, 0.95, -0.45, 0, -0.9, -0.95], // Chaser: 화살촉
  [1.7, 0, -1, 0.8, -0.35, 0, -1, -0.8], // Runner: 가는 다트
  polygon(6), // Tank: 육각형
  [1.25, 0, 0, 1.25, -1.25, 0, 0, -1.25], // Shooter: 마름모
  polygon(16, 0.72), // Boss: 별
  polygon(12, 0.62), // Bomber: 가시 달린 기뢰
];

function glowSprite(color: string, size = 64): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, color);
  grad.addColorStop(0.35, color + '55');
  grad.addColorStop(1, color + '00');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

function loadSprite(url: string) {
  const image = new Image();
  const flash = document.createElement('canvas');
  flash.width = flash.height = 0;
  image.addEventListener('load', () => {
    flash.width = image.naturalWidth;
    flash.height = image.naturalHeight;
    const ctx = flash.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, flash.width, flash.height);
  }, { once: true });
  image.src = url;
  return { image, flash };
}

function drawSprite(
  ctx: CanvasRenderingContext2D, image: CanvasImageSource,
  x: number, y: number, ux: number, uy: number, size: number, pivotX = 0.5,
): void {
  ctx.save();
  ctx.transform(ux, uy, -uy, ux, x, y);
  ctx.drawImage(image, -size * pivotX, -size / 2, size, size);
  ctx.restore();
}

function drawPlayerFlame(
  ctx: CanvasRenderingContext2D, image: HTMLImageElement,
  x: number, y: number, ux: number, uy: number, time: number,
): void {
  const size = PLAYER_SPRITE_SIZE;
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const split = Math.round(width * 0.44);
  const tailWidth = size * split / width;
  const joint = tailWidth - size * PLAYER_SPRITE_PIVOT;

  ctx.save();
  ctx.transform(ux, uy, -uy, ux, x, y);
  ctx.fillStyle = '#ffba58';
  for (let i = 0; i < 4; i++) {
    const age = (time * 2.6 + i * 0.25) % 1;
    const radius = 1.5 - age;
    ctx.globalAlpha = 0.8 * (1 - age);
    ctx.beginPath();
    ctx.arc(-24 - age * (24 + i * 3), (i - 1.5) * (5 + age * 6), radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 코어 앞쪽을 고정하고 이음새 뒤로 꼬리만 늘리거나 휘게 한다.
  ctx.save();
  const stretch = 1 + 0.17 * Math.sin(time * 18) + 0.07 * Math.sin(time * 29);
  ctx.transform(stretch, 0.14 * Math.sin(time * 15), 0, 1, joint, 0);
  ctx.drawImage(image, 0, 0, split + 1, height, -tailWidth, -size / 2, tailWidth + size / width, size);
  ctx.restore();
  ctx.drawImage(image, split, 0, width - split, height, joint, -size / 2, size - tailWidth, size);
  ctx.restore();
}

export interface DrawOptions {
  alpha: number; // 틱 사이 보간 계수 0~1
  time: number; // 초 단위 실제 시간 (애니메이션용)
  showPlayer: boolean;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private zoom = 1;
  private glows = KIND_COLOR.map((c) => glowSprite(c));
  private glowPlayer = glowSprite('#ffb347', 128);
  private glowHostile = glowSprite('#ff3355');
  private glowBlade = glowSprite('#7fe3ff');
  private glowGem = glowSprite('#5df2c0', 32);
  private glowElite = glowSprite(ELITE_COLOR, 128);
  private glowLance = glowSprite('#ffd23f');
  private playerSprite = loadSprite(playerUrl);
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private enemySprites = [
    { ...loadSprite(chaserUrl), scale: 2.5, pivot: 0.415 },
    { ...loadSprite(runnerUrl), scale: 3.6, pivot: 0.35 },
    { ...loadSprite(tankUrl), scale: 2.5, pivot: 0.5 },
    { ...loadSprite(shooterUrl), scale: 2.5, pivot: 0.43 },
    { ...loadSprite(bossUrl), scale: 2.2, pivot: 0.4 },
    { ...loadSprite(bomberUrl), scale: 2.5, pivot: 0.5 },
  ];
  private floorPattern: CanvasPattern | null = null;
  private blades: number[] = [];
  drawn = 0; // 마지막 프레임에 실제로 그린 적 수 (디버그 표시용)

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    const floor = new Image();
    floor.addEventListener('load', () => {
      this.floorPattern = this.ctx.createPattern(floor, 'repeat');
    }, { once: true });
    floor.src = floorUrl;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    // 화면 비율이 달라도 보이는 월드 범위가 1200x700(세로 화면은 700x1200)을 넘지 않게 한다.
    // 대각선 절반이 스폰 링 반지름(720)보다 짧아서 적이 화면 안에서 생겨나 보이지 않는다.
    this.zoom = this.w >= this.h ? Math.max(this.w / 1200, this.h / 700) : Math.max(this.w / 700, this.h / 1200);
  }

  draw(s: SimState, fx: Fx, o: DrawOptions): void {
    const ctx = this.ctx;
    const a = o.alpha;
    const p = s.player;
    const camX = p.px + (p.x - p.px) * a + (Math.random() - 0.5) * fx.shake;
    const camY = p.py + (p.y - p.py) * a + (Math.random() - 0.5) * fx.shake;
    const scale = this.zoom * this.dpr;
    const halfW = this.w / this.zoom / 2;
    const halfH = this.h / this.zoom / 2;
    const vx0 = camX - halfW - 60;
    const vx1 = camX + halfW + 60;
    const vy0 = camY - halfH - 60;
    const vy1 = camY + halfH + 60;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#04050a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(scale, 0, 0, scale, (this.w / 2) * this.dpr - camX * scale, (this.h / 2) * this.dpr - camY * scale);

    // 바닥과 격자
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = this.floorPattern ?? '#0a0c16';
    ctx.fillRect(0, 0, ARENA, ARENA);
    ctx.imageSmoothingEnabled = true;
    ctx.beginPath();
    const gx0 = Math.max(0, Math.floor(vx0 / 80) * 80);
    const gy0 = Math.max(0, Math.floor(vy0 / 80) * 80);
    for (let x = gx0; x <= Math.min(ARENA, vx1); x += 80) {
      ctx.moveTo(x, Math.max(0, vy0));
      ctx.lineTo(x, Math.min(ARENA, vy1));
    }
    for (let y = gy0; y <= Math.min(ARENA, vy1); y += 80) {
      ctx.moveTo(Math.max(0, vx0), y);
      ctx.lineTo(Math.min(ARENA, vx1), y);
    }
    ctx.strokeStyle = 'rgba(120,140,255,0.07)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = '#5468ff';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, ARENA, ARENA);

    // ── 위험 예고 (바닥에 깔리는 표시) ──
    for (const e of s.enemies) {
      if (e.x < vx0 - 200 || e.x > vx1 + 200 || e.y < vy0 - 200 || e.y > vy1 + 200) continue;
      const x = e.px + (e.x - e.px) * a;
      const y = e.py + (e.y - e.py) * a;
      if (e.kind === Kind.Bomber && e.mode === 1) {
        // 도화선: 폭발 범위를 채워 가며, 끝에 가까울수록 빠르게 깜빡인다
        const t = 1 - e.timer / BOMBER.fuse;
        const blink = Math.sin(o.time * (10 + t * 30)) > 0 ? 1 : 0.6;
        ctx.beginPath();
        ctx.arc(x, y, BOMBER.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,90,40,${(0.08 + t * 0.22) * blink})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(255,120,60,${0.5 + t * 0.5})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, BOMBER.radius * t, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,140,60,0.18)';
        ctx.fill();
      } else if (e.kind === Kind.Boss && e.mode === 1) {
        // 돌진 예고선: 조준이 고정되면 진하게 바뀐다
        const locked = e.timer <= BOSS_CHARGE.lock;
        const len = BOSS_CHARGE.speed * BOSS_CHARGE.dash * (1 / 60);
        ctx.save();
        ctx.translate(x, y);
        ctx.transform(e.ax, e.ay, -e.ay, e.ax, 0, 0);
        ctx.fillStyle = locked ? 'rgba(255,60,120,0.32)' : `rgba(255,80,200,${0.1 + 0.08 * Math.sin(o.time * 20)})`;
        ctx.fillRect(0, -e.r, len, e.r * 2);
        ctx.restore();
      }
    }

    // ── 가산 합성 레이어: 빛 번짐 ──
    ctx.globalCompositeOperation = 'lighter';

    for (const g of s.gems) {
      if (g.x < vx0 || g.x > vx1 || g.y < vy0 || g.y > vy1) continue;
      const x = g.px + (g.x - g.px) * a;
      const y = g.py + (g.y - g.py) * a;
      const sz = g.value >= 3 ? 26 : 18;
      ctx.drawImage(this.glowGem, x - sz / 2, y - sz / 2, sz, sz);
    }

    this.drawn = 0;
    for (const e of s.enemies) {
      if (e.x < vx0 || e.x > vx1 || e.y < vy0 || e.y > vy1) continue;
      const x = e.px + (e.x - e.px) * a;
      const y = e.py + (e.y - e.py) * a;
      const sz = e.r * 4.6;
      ctx.drawImage(this.glows[e.kind], x - sz / 2, y - sz / 2, sz, sz);
      if (e.elite) {
        const es = e.r * (5.5 + 0.6 * Math.sin(o.time * 5));
        ctx.drawImage(this.glowElite, x - es / 2, y - es / 2, es, es);
      }
      this.drawn++;
    }

    // 보물 상자
    for (const c of s.chests) {
      const sz = 70 + 10 * Math.sin(o.time * 4);
      ctx.drawImage(this.glowElite, c.x - sz / 2, c.y - sz / 2, sz, sz);
    }

    // 플레이어 탄환: 진행 방향 반대로 꼬리를 그린다 (태양창은 빛을 두른다)
    const lance = s.levels[Up.SunLance] > 0;
    if (lance) {
      for (const b of s.bullets) {
        if (b.hostile) continue;
        const x = b.px + (b.x - b.px) * a;
        const y = b.py + (b.y - b.py) * a;
        ctx.drawImage(this.glowLance, x - 16, y - 16, 32, 32);
      }
    }
    ctx.beginPath();
    for (const b of s.bullets) {
      if (b.hostile) continue;
      const x = b.px + (b.x - b.px) * a;
      const y = b.py + (b.y - b.py) * a;
      ctx.moveTo(x - b.vx * 0.035, y - b.vy * 0.035);
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = lance ? '#fff3b0' : '#ffd27a';
    ctx.lineWidth = lance ? 5 : 3.5;
    ctx.lineCap = 'round';
    ctx.stroke();

    for (const b of s.bullets) {
      if (!b.hostile || b.x < vx0 || b.x > vx1 || b.y < vy0 || b.y > vy1) continue;
      const x = b.px + (b.x - b.px) * a;
      const y = b.py + (b.y - b.py) * a;
      ctx.drawImage(this.glowHostile, x - 14, y - 14, 28, 28);
    }

    const px = p.px + (p.x - p.px) * a;
    const py = p.py + (p.y - p.py) * a;

    // 공전 칼날
    const bladeCount = orbitBlades(s, this.blades);
    const radius = orbitRadius(s);
    const tempest = s.levels[Up.Tempest] > 0;
    if (bladeCount > 0 && o.showPlayer) {
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.strokeStyle = tempest ? 'rgba(79,217,255,0.28)' : 'rgba(127,227,255,0.10)';
      ctx.lineWidth = 2;
      ctx.stroke();
      for (let i = 0; i < bladeCount; i++) {
        const bx = px + this.blades[i * 2] * radius;
        const by = py + this.blades[i * 2 + 1] * radius;
        ctx.drawImage(this.glowBlade, bx - 30, by - 30, 60, 60);
      }
    }

    for (const r of fx.rings) {
      const t = 1 - r.life / r.max;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r * (0.25 + 0.75 * t), 0, Math.PI * 2);
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 10 * (1 - t) + 2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 연쇄 번개: 매 프레임 지그재그를 새로 만들어 떨리게 한다
    if (fx.bolts.length) {
      ctx.beginPath();
      for (const b of fx.bolts) {
        const pts = b.pts;
        ctx.moveTo(pts[0], pts[1]);
        for (let i = 2; i < pts.length; i += 2) {
          const mx = (pts[i - 2] + pts[i]) / 2 + (Math.random() - 0.5) * 26;
          const my = (pts[i - 1] + pts[i + 1]) / 2 + (Math.random() - 0.5) * 26;
          ctx.lineTo(mx, my);
          ctx.lineTo(pts[i], pts[i + 1]);
        }
      }
      ctx.strokeStyle = '#fff27a';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    for (const q of fx.particles) {
      ctx.globalAlpha = q.life / q.max;
      ctx.fillStyle = q.color;
      ctx.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
    }
    ctx.globalAlpha = 1;

    if (o.showPlayer) {
      const gs = p.dashT > 0 ? 150 : 110;
      ctx.drawImage(this.glowPlayer, px - gs / 2, py - gs / 2, gs, gs);
    }

    // ── 일반 합성 레이어: 선명한 외곽선 ──
    ctx.globalCompositeOperation = 'source-over';

    ctx.beginPath();
    for (const g of s.gems) {
      if (g.x < vx0 || g.x > vx1 || g.y < vy0 || g.y > vy1) continue;
      const x = g.px + (g.x - g.px) * a;
      const y = g.py + (g.y - g.py) * a;
      const r = g.value >= 3 ? 6 : 4;
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
    }
    ctx.fillStyle = '#b9ffe9';
    ctx.fill();

    // 도형으로 그리는 적은 종류별 한 경로에 모은다.
    const spin = o.time * 0.8;
    for (let kind = 0; kind < SHAPES.length; kind++) {
      const shape = SHAPES[kind];
      const sprite = this.enemySprites[kind];
      for (let pass = 0; pass < 2; pass++) {
        let any = false;
        ctx.beginPath();
        for (const e of s.enemies) {
          if (e.kind !== kind || e.flash > 0 !== (pass === 1)) continue;
          if (e.x < vx0 || e.x > vx1 || e.y < vy0 || e.y > vy1) continue;
          const x = e.px + (e.x - e.px) * a;
          const y = e.py + (e.y - e.py) * a;
          let ux = 1;
          let uy = 0;
          if (kind === Kind.Boss) {
            ux = e.mode === 0 ? Math.cos(spin) : e.ax;
            uy = e.mode === 0 ? Math.sin(spin) : e.ay;
          } else if (kind !== Kind.Tank) {
            const dx = px - x;
            const dy = py - y;
            const d = Math.hypot(dx, dy);
            if (d > 0) {
              ux = dx / d;
              uy = dy / d;
            }
          }
          const r = e.r;
          if (sprite.flash.width) {
            const image = pass === 1 ? sprite.flash : sprite.image;
            // 비대칭 스프라이트의 코어가 충돌 중심에 놓이도록 보정한다.
            drawSprite(ctx, image, x, y, ux, uy, r * sprite.scale, sprite.pivot);
            continue;
          }
          for (let i = 0; i < shape.length; i += 2) {
            const lx = shape[i] * r;
            const ly = shape[i + 1] * r;
            const wx = x + lx * ux - ly * uy;
            const wy = y + lx * uy + ly * ux;
            if (i === 0) ctx.moveTo(wx, wy);
            else ctx.lineTo(wx, wy);
          }
          ctx.closePath();
          any = true;
        }
        if (!any) continue;
        if (pass === 1) {
          ctx.fillStyle = '#ffffff';
          ctx.fill();
        } else {
          ctx.fillStyle = KIND_COLOR[kind] + '3a';
          ctx.fill();
          ctx.strokeStyle = KIND_COLOR[kind];
          ctx.lineWidth = kind === Kind.Boss ? 4 : 2;
          ctx.lineJoin = 'round';
          ctx.stroke();
        }
      }
    }

    // 엘리트 금테, 마비 표시, 체력이 깎인 탱크·엘리트의 체력 바
    for (const e of s.enemies) {
      if (e.x < vx0 || e.x > vx1 || e.y < vy0 || e.y > vy1) continue;
      const x = e.px + (e.x - e.px) * a;
      const y = e.py + (e.y - e.py) * a;
      if (e.elite) {
        ctx.beginPath();
        ctx.arc(x, y, e.r + 6, 0, Math.PI * 2);
        ctx.strokeStyle = ELITE_COLOR;
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      if (e.stun > 0) {
        ctx.beginPath();
        ctx.arc(x, y, e.r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,247,176,0.85)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (e.kind !== Kind.Tank || e.hp >= e.maxHp) continue;
      const w = e.elite ? 60 : 36;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x - w / 2, y - e.r - 12, w, e.elite ? 6 : 4);
      ctx.fillStyle = e.elite ? ELITE_COLOR : KIND_COLOR[Kind.Tank];
      ctx.fillRect(x - w / 2, y - e.r - 12, w * Math.max(0, e.hp / e.maxHp), e.elite ? 6 : 4);
    }

    // 보물 상자 본체
    for (const c of s.chests) {
      const bob = Math.sin(o.time * 4) * 2;
      ctx.fillStyle = '#5a3b10';
      ctx.fillRect(c.x - 12, c.y - 9 + bob, 24, 18);
      ctx.strokeStyle = ELITE_COLOR;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(c.x - 12, c.y - 9 + bob, 24, 18);
      ctx.fillStyle = ELITE_COLOR;
      ctx.fillRect(c.x - 12, c.y - 2 + bob, 24, 3);
      ctx.fillRect(c.x - 2.5, c.y - 4 + bob, 5, 7);
    }

    ctx.beginPath();
    for (const b of s.bullets) {
      if (!b.hostile || b.x < vx0 || b.x > vx1 || b.y < vy0 || b.y > vy1) continue;
      const x = b.px + (b.x - b.px) * a;
      const y = b.py + (b.y - b.py) * a;
      ctx.moveTo(x + 4.5, y);
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    }
    ctx.fillStyle = '#ffd0d8';
    ctx.fill();

    if (bladeCount > 0 && o.showPlayer) {
      ctx.beginPath();
      for (let i = 0; i < bladeCount; i++) {
        const bx = px + this.blades[i * 2] * radius;
        const by = py + this.blades[i * 2 + 1] * radius;
        ctx.moveTo(bx + 7, by);
        ctx.arc(bx, by, 7, 0, Math.PI * 2);
      }
      ctx.fillStyle = tempest ? '#b8f3ff' : '#e8fbff';
      ctx.fill();
    }

    if (o.showPlayer) {
      // 피격 무적 중에는 깜빡인다
      const blink = p.iframes > 0 && Math.floor(o.time * 20) % 2 === 0;
      if (!blink && this.playerSprite.flash.width) {
        const image = p.dashT > 0 ? this.playerSprite.flash : this.playerSprite.image;
        if (p.dashT > 0 || this.reducedMotion.matches) {
          drawSprite(ctx, image, px, py, p.fx, p.fy, PLAYER_SPRITE_SIZE, PLAYER_SPRITE_PIVOT);
        } else {
          drawPlayerFlame(ctx, this.playerSprite.image, px, py, p.fx, p.fy, (s.tick + a) * DT);
        }
      } else if (!blink) {
        ctx.beginPath();
        ctx.arc(px, py, PLAYER_R, 0, Math.PI * 2);
        ctx.fillStyle = p.dashT > 0 ? '#ffffff' : '#fff1cf';
        ctx.fill();
        ctx.strokeStyle = '#ffb347';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(px + p.fx * 5, py + p.fy * 5, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ff7a1a';
        ctx.fill();
      }
    }

    if (fx.texts.length) {
      ctx.textAlign = 'center';
      for (const t of fx.texts) {
        ctx.globalAlpha = Math.min(1, t.life * 3);
        ctx.font = `700 ${t.size}px system-ui, sans-serif`;
        ctx.fillStyle = t.color;
        ctx.fillText(t.text, t.x, t.y);
      }
      ctx.globalAlpha = 1;
    }

    // ── 화면 고정 레이어 ──
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // 화면 밖 보스 방향 표시
    if (s.bossSpawned && o.showPlayer) {
      for (const e of s.enemies) {
        if (e.kind !== Kind.Boss) continue;
        const dx = e.x - px;
        const dy = e.y - py;
        if (Math.abs(dx) < halfW - 20 && Math.abs(dy) < halfH - 20) break;
        const ang = Math.atan2(dy, dx);
        const k = Math.min((this.w / 2 - 36) / Math.abs(Math.cos(ang) || 1e-6), (this.h / 2 - 36) / Math.abs(Math.sin(ang) || 1e-6));
        ctx.save();
        ctx.translate(this.w / 2 + Math.cos(ang) * k, this.h / 2 + Math.sin(ang) * k);
        ctx.rotate(ang);
        ctx.beginPath();
        ctx.moveTo(14, 0);
        ctx.lineTo(-10, 10);
        ctx.lineTo(-10, -10);
        ctx.closePath();
        ctx.fillStyle = KIND_COLOR[Kind.Boss];
        ctx.fill();
        ctx.restore();
        break;
      }
    }

    // 비네트 + 피격/저체력 붉은 테두리
    const lowHp = o.showPlayer && p.hp > 0 && p.hp < p.maxHp * 0.3 ? 0.25 + 0.12 * Math.sin(o.time * 6) : 0;
    const red = Math.max(fx.hurt * 0.6, lowHp);
    const vg = ctx.createRadialGradient(this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.35, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, red > 0 ? `rgba(${Math.round(120 + 135 * red)},0,${Math.round(30 * red)},${0.55 + red * 0.3})` : 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, this.w, this.h);

    if (fx.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${fx.flash * 0.5})`;
      ctx.fillRect(0, 0, this.w, this.h);
    }
  }
}
