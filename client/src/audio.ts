// Web Audio 효과음. 경고음은 WAV, 나머지는 오실레이터와 노이즈로 합성한다.
// 같은 소리가 한 프레임에 수십 번 울리지 않도록 소리별 최소 간격을 둔다.

import fuseUrl from '../assets/audio/bomber-fuse.wav';
import chargeUrl from '../assets/audio/boss-charge.wav';

type Wave = OscillatorType;
const WARNING_URLS = { fuse: fuseUrl, charge: chargeUrl };

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private last = new Map<string, number>();
  private warnings: Partial<Record<keyof typeof WARNING_URLS, AudioBuffer>> = {};
  private gemStreak = 0;
  private gemAt = 0;
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem('ember.muted') === '1';
    } catch {
      /* 저장소를 못 쓰는 환경에서는 기본값 사용 */
    }
  }

  /** 브라우저 정책상 사용자 입력 이후에만 오디오를 시작할 수 있다. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 0.5;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      for (const kind of ['fuse', 'charge'] as const) {
        void fetch(WARNING_URLS[kind])
          .then((response) => {
            if (!response.ok) throw new Error(`Warning audio: ${response.status}`);
            return response.arrayBuffer();
          })
          .then((bytes) => this.ctx!.decodeAudioData(bytes))
          .then((buffer) => { this.warnings[kind] = buffer; })
          .catch(() => { /* 파일을 읽지 못하면 합성 경고음 사용 */ });
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    try {
      localStorage.setItem('ember.muted', this.muted ? '1' : '0');
    } catch {
      /* 무시 */
    }
    return this.muted;
  }

  private gate(name: string, minGap: number): boolean {
    if (!this.ctx || this.muted) return false;
    const now = this.ctx.currentTime;
    if (now - (this.last.get(name) ?? -1) < minGap) return false;
    this.last.set(name, now);
    return true;
  }

  private tone(type: Wave, f0: number, f1: number, dur: number, vol: number, delay = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private hiss(dur: number, vol: number, freq: number, q = 1): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(this.master!);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  shoot(): void {
    if (this.gate('shoot', 0.07)) this.tone('triangle', 720, 320, 0.07, 0.06);
  }
  hit(): void {
    if (this.gate('hit', 0.04)) this.hiss(0.05, 0.1, 2400, 0.8);
  }
  kill(): void {
    if (this.gate('kill', 0.05)) {
      this.tone('square', 300, 70, 0.14, 0.07);
      this.hiss(0.12, 0.1, 900);
    }
  }
  gem(): void {
    if (!this.gate('gem', 0.03)) return;
    // 연속으로 주울수록 음이 올라간다
    const now = this.ctx!.currentTime;
    this.gemStreak = now - this.gemAt < 0.35 ? Math.min(this.gemStreak + 1, 12) : 0;
    this.gemAt = now;
    const f = 660 * Math.pow(2, this.gemStreak / 12);
    this.tone('sine', f, f * 1.5, 0.08, 0.07);
  }
  dash(): void {
    if (this.gate('dash', 0.1)) this.hiss(0.2, 0.16, 1400, 0.5);
  }
  hurt(): void {
    if (this.gate('hurt', 0.1)) {
      this.tone('sawtooth', 180, 45, 0.3, 0.22);
      this.hiss(0.2, 0.2, 300);
    }
  }
  nova(): void {
    if (this.gate('nova', 0.1)) {
      this.tone('sine', 140, 40, 0.4, 0.22);
      this.hiss(0.3, 0.1, 500, 0.4);
    }
  }
  chain(): void {
    if (this.gate('chain', 0.08)) {
      this.hiss(0.12, 0.14, 5200, 2);
      this.tone('sawtooth', 1500, 280, 0.1, 0.04);
    }
  }
  enemyShoot(): void {
    if (this.gate('eshoot', 0.12)) this.tone('square', 240, 160, 0.1, 0.04);
  }
  levelUp(): void {
    if (!this.gate('levelup', 0.2)) return;
    [523, 659, 784, 1047].forEach((f, i) => this.tone('triangle', f, f, 0.16, 0.12, i * 0.07));
  }
  pick(): void {
    if (this.gate('pick', 0.05)) this.tone('triangle', 880, 1320, 0.12, 0.12);
  }
  warn(): void {
    if (!this.gate('warn', 0.5)) return;
    for (let i = 0; i < 3; i++) this.tone('sawtooth', 110, 104, 0.32, 0.16, i * 0.4);
  }
  warning(kind: keyof typeof WARNING_URLS): void {
    if (!this.gate(kind, kind === 'fuse' ? 0.25 : 0.5)) return;
    const buffer = this.warnings[kind];
    if (!buffer) {
      this.warn();
      return;
    }
    const source = this.ctx!.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx!.createGain();
    gain.gain.value = 0.55;
    source.connect(gain).connect(this.master!);
    source.start();
  }
  win(): void {
    if (!this.gate('win', 1)) return;
    [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => this.tone('triangle', f, f, 0.34, 0.14, i * 0.11));
  }
  blast(): void {
    if (this.gate('blast', 0.06)) {
      this.tone('sine', 110, 35, 0.3, 0.2);
      this.hiss(0.25, 0.16, 380, 0.5);
    }
  }
  chest(): void {
    if (!this.gate('chest', 0.3)) return;
    [784, 988, 1175, 1568].forEach((f, i) => this.tone('sine', f, f * 1.01, 0.2, 0.12, i * 0.05));
  }
  evolve(): void {
    if (!this.gate('evolve', 0.5)) return;
    [262, 392, 523, 784, 1047].forEach((f, i) => this.tone('sawtooth', f, f, 0.3, 0.07, i * 0.06));
    this.tone('sine', 60, 30, 0.8, 0.25);
  }
  lose(): void {
    if (!this.gate('lose', 1)) return;
    [392, 330, 262, 196].forEach((f, i) => this.tone('sawtooth', f, f * 0.96, 0.4, 0.1, i * 0.18));
  }
}
