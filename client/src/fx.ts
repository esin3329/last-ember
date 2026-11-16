// 연출 전용 이펙트(파티클, 데미지 숫자, 링, 번개, 화면 흔들림).
// 시뮬레이션 결과에 영향을 주지 않으므로 여기서는 Math.random과 실제 프레임 시간을 써도 된다.
// 파티클은 미리 만들어 둔 풀을 재사용해서 플레이 중 가비지가 생기지 않게 한다.

export interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; max: number; size: number; color: string;
}

export interface FloatText {
  x: number; y: number; life: number; text: string; color: string; size: number;
}

export interface Ring {
  x: number; y: number; r: number; life: number; max: number; color: string;
}

export interface Bolt {
  pts: number[]; life: number;
}

const MAX_PARTICLES = 700;
const MAX_TEXTS = 48;

export class Fx {
  particles: Particle[] = [];
  private pool: Particle[] = [];
  texts: FloatText[] = [];
  rings: Ring[] = [];
  bolts: Bolt[] = [];
  shake = 0;
  hurt = 0; // 피격 시 붉은 화면 테두리 (1 → 0)
  flash = 0; // 화면 전체 섬광

  constructor() {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.pool.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 2, color: '#fff' });
    }
  }

  clear(): void {
    while (this.particles.length) this.pool.push(this.particles.pop()!);
    this.texts.length = 0;
    this.rings.length = 0;
    this.bolts.length = 0;
    this.shake = 0;
    this.hurt = 0;
    this.flash = 0;
  }

  burst(x: number, y: number, color: string, count: number, speed: number, size = 3, life = 0.45): void {
    for (let i = 0; i < count; i++) {
      const p = this.pool.pop();
      if (!p) return;
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random() * 0.7);
      p.x = x;
      p.y = y;
      p.vx = Math.cos(a) * v;
      p.vy = Math.sin(a) * v;
      p.max = p.life = life * (0.6 + Math.random() * 0.6);
      p.size = size * (0.6 + Math.random() * 0.8);
      p.color = color;
      this.particles.push(p);
    }
  }

  text(x: number, y: number, text: string, color: string, size = 14): void {
    if (this.texts.length >= MAX_TEXTS) this.texts.shift();
    this.texts.push({ x: x + (Math.random() - 0.5) * 14, y: y - 8, life: 0.6, text, color, size });
  }

  ring(x: number, y: number, r: number, color: string, life = 0.35): void {
    this.rings.push({ x, y, r, life, max: life, color });
  }

  bolt(pts: number[]): void {
    this.bolts.push({ pts, life: 0.14 });
  }

  addShake(amount: number): void {
    this.shake = Math.min(18, this.shake + amount);
  }

  update(dt: number): void {
    const ps = this.particles;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.pool.push(p);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.94;
      p.vy *= 0.94;
      ps[w++] = p;
    }
    ps.length = w;

    w = 0;
    for (const t of this.texts) {
      t.life -= dt;
      t.y -= 46 * dt;
      if (t.life > 0) this.texts[w++] = t;
    }
    this.texts.length = w;

    w = 0;
    for (const r of this.rings) {
      r.life -= dt;
      if (r.life > 0) this.rings[w++] = r;
    }
    this.rings.length = w;

    w = 0;
    for (const b of this.bolts) {
      b.life -= dt;
      if (b.life > 0) this.bolts[w++] = b;
    }
    this.bolts.length = w;

    this.shake *= Math.pow(0.0015, dt);
    if (this.shake < 0.05) this.shake = 0;
    this.hurt = Math.max(0, this.hurt - dt * 2.2);
    this.flash = Math.max(0, this.flash - dt * 3);
  }
}
