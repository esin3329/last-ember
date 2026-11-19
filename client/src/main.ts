// 게임 컨트롤러: 모드 전환(메뉴 / 플레이 / 리플레이)과 메인 루프.
//
// 메인 루프는 "고정 타임스텝 + 누적기" 구조다. 화면은 매 프레임 그리지만
// 시뮬레이션은 정확히 1/60초 단위로만 전진하고, 그때 넣은 입력을 전부 기록한다.
// 그래서 기록한 입력만 다시 넣으면 어디서든 같은 판이 재현된다.

import { botInput } from '../../shared/bot.ts';
import { DT, Kind, SIM_VERSION, UPGRADE_META } from '../../shared/defs.ts';
import { type InputFrame, InputRecorder, decodeFrame, encodeFrame, expandRuns } from '../../shared/input.ts';
import { type SimEvent, type SimState, createSim, resultOf, step } from '../../shared/sim.ts';
import * as api from './api.ts';
import { Sfx } from './audio.ts';
import { Fx } from './fx.ts';
import { Keyboard } from './keyboard.ts';
import { Renderer, kindColor } from './render.ts';
import { setupTouch } from './touch.ts';
import * as ui from './ui.ts';

type Mode = 'menu' | 'play' | 'replay';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const fx = new Fx();
const sfx = new Sfx();
const kb = new Keyboard();
const frame: InputFrame = { mx: 0, my: 0, dash: false, choice: -1 };

let mode: Mode = 'menu';
let sim: SimState = createSim(randomSeed());
let recorder = new InputRecorder();
let runId: string | null = null; // 서버가 발급한 판 ID (오프라인이면 null)
let seed = 0;
let paused = false;
let finished = false;
let acc = 0;
let hitstop = 0;
let levelUiKey = '';
let starting = false;
let hintShown = false;
// 개발 빌드 전용: ?autoplay 로 열면 봇이 대신 플레이한다(브라우저↔서버 검증 흐름을 손 안 대고 시험).
const AUTOPLAY = import.meta.env.DEV && new URLSearchParams(location.search).has('autoplay');

// 리플레이 상태
let replayCodes: Uint8Array = new Uint8Array(0);
let replayIdx = 0;
let replaySpeed = 1;
let replayLabel = '';
let lastRun: { seed: number; runs: number[] } | null = null;

// 성능 측정 (F3)
let debugOn = false;
let fps = 0;
let fpsFrames = 0;
let fpsTime = 0;
let simMs = 0;

function randomSeed(): number {
  return (Math.random() * 0x7fffffff) | 0 || 1;
}

function playerName(): string {
  return ui.dom.name.value.trim() || '익명';
}

// ───────────────────────── 모드 전환 ─────────────────────────

function resetWorld(newSim: SimState): void {
  sim = newSim;
  fx.clear();
  kb.reset();
  acc = 0;
  hitstop = 0;
  paused = false;
  finished = false;
  levelUiKey = '';
  ui.hideLevelUp();
  ui.hideResult();
  ui.showPause(false);
}

function setMode(next: Mode): void {
  mode = next;
  document.body.classList.toggle('playing', next === 'play');
}

function enterMenu(): void {
  setMode('menu');
  resetWorld(createSim(randomSeed()));
  ui.showMenu(true);
  ui.showHud(false);
  ui.setBanner(null);
  void refreshBoard();
}

async function startGame(): Promise<void> {
  if (starting) return;
  starting = true;
  sfx.unlock();
  try {
    localStorage.setItem('ember.name', ui.dom.name.value);
  } catch {
    /* 무시 */
  }
  // 시드는 서버가 정한다. 서버가 없으면 로컬 시드로 오프라인 플레이.
  const issued = await api.issueRun();
  starting = false;
  runId = issued && issued.simVersion === SIM_VERSION ? issued.runId : null;
  seed = runId ? issued!.seed : randomSeed();
  ui.setNet(issued ? 'on' : 'off');
  recorder = new InputRecorder();
  setMode('play');
  resetWorld(createSim(seed));
  ui.showMenu(false);
  ui.showHud(true);
  // 처음 몇 초 동안만 조작 안내를 띄운다
  hintShown = true;
  ui.setBanner(document.body.classList.contains('touch') || matchMedia('(pointer: coarse)').matches ? '화면을 끌어 이동 · 대시 버튼으로 회피 · 공격은 자동' : 'WASD 이동 · Space 대시 · 공격은 자동');
}

function startReplay(replaySeed: number, runs: number[], label: string): void {
  sfx.unlock();
  replayCodes = expandRuns(runs);
  replayIdx = 0;
  replaySpeed = 1;
  replayLabel = label;
  hintShown = false;
  setMode('replay');
  resetWorld(createSim(replaySeed));
  ui.showMenu(false);
  ui.showHud(true);
  updateBanner();
}

function updateBanner(): void {
  ui.setBanner(`리플레이 · ${replayLabel} · ${replaySpeed}배속 — Space 속도 변경 · Esc 나가기`);
}

async function watchFromBoard(entry: api.BoardEntry): Promise<void> {
  const data = await api.fetchReplay(entry.runId);
  if (!data || data.simVersion !== SIM_VERSION) {
    ui.toast('리플레이를 불러올 수 없습니다');
    return;
  }
  startReplay(data.seed, data.inputs, `${data.name} (${data.score.toLocaleString()}점)`);
}

async function refreshBoard(): Promise<void> {
  const entries = await api.fetchBoard();
  ui.setNet(entries ? 'on' : 'off');
  ui.renderBoard(entries, (e) => void watchFromBoard(e));
}

// ───────────────────────── 시뮬레이션 진행 ─────────────────────────

/** 한 틱 진행. 입력을 기다려야 해서 진행할 수 없으면 false. */
function stepOnce(): boolean {
  if (mode === 'play' && AUTOPLAY) {
    botInput(sim, frame);
    recorder.push(encodeFrame(frame));
    step(sim, frame);
  } else if (mode === 'play') {
    if (sim.phase === 'levelup') {
      if (kb.choiceQueued < 0 || kb.choiceQueued >= sim.choices.length) {
        kb.choiceQueued = -1;
        return false;
      }
      frame.mx = 0;
      frame.my = 0;
      frame.dash = false;
      frame.choice = kb.choiceQueued;
      sfx.pick();
    } else {
      frame.mx = kb.mx;
      frame.my = kb.my;
      frame.dash = kb.dashQueued;
      frame.choice = -1;
    }
    kb.reset();
    recorder.push(encodeFrame(frame));
    step(sim, frame);
  } else if (mode === 'replay') {
    if (replayIdx >= replayCodes.length) return false;
    step(sim, decodeFrame(replayCodes[replayIdx++], frame));
  } else {
    step(sim, botInput(sim, frame));
  }

  handleEvents(sim.events);
  if (sim.phase === 'dead' || sim.phase === 'won') onFinish();
  return true;
}

function advance(dt: number): void {
  if (hitstop > 0) {
    hitstop -= dt;
    return;
  }
  const speed = mode === 'replay' ? replaySpeed : 1;
  acc += dt * speed;
  // 프레임이 밀려도 한 번에 따라잡는 틱 수를 제한한다(죽음의 나선 방지).
  let budget = 6 * speed;
  const t0 = performance.now();
  while (acc >= DT && !finished) {
    if (budget-- <= 0 || !stepOnce()) {
      acc = 0;
      break;
    }
    acc -= DT;
  }
  simMs = simMs * 0.9 + (performance.now() - t0) * 0.1;
  syncLevelUi();
}

function syncLevelUi(): void {
  if (mode !== 'play' || sim.phase !== 'levelup') {
    if (levelUiKey) {
      levelUiKey = '';
      ui.hideLevelUp();
    }
    return;
  }
  // 한 번에 여러 레벨이 오르면 선택지가 연달아 바뀌므로 내용으로 갱신 여부를 판단한다.
  const key = `${sim.player.level}:${sim.pendingLevels}:${sim.choices.join(',')}`;
  if (key === levelUiKey) return;
  levelUiKey = key;
  kb.choiceQueued = -1;
  ui.showLevelUp(sim, (i) => {
    kb.choiceQueued = i;
  });
}

// ───────────────────────── 이벤트 → 연출 ─────────────────────────

function handleEvents(events: SimEvent[]): void {
  const quiet = mode === 'menu';
  const p = sim.player;
  for (const ev of events) {
    switch (ev.t) {
      case 'hit':
        fx.burst(ev.x, ev.y, '#ffffff', 2, 140, 2.5, 0.2);
        if (!quiet) {
          fx.text(ev.x, ev.y, String(Math.round(ev.dmg)), ev.dmg >= 30 ? '#ffd27a' : '#ffffff', ev.dmg >= 30 ? 17 : 13);
          sfx.hit();
        }
        break;
      case 'kill': {
        const boss = ev.kind === Kind.Boss;
        fx.burst(ev.x, ev.y, kindColor(ev.kind), boss ? 160 : 7 + ev.r / 2, boss ? 620 : 240, boss ? 7 : 4, boss ? 1.2 : 0.45);
        if (ev.elite) {
          fx.burst(ev.x, ev.y, '#ffd23f', 60, 420, 5, 0.8);
          fx.ring(ev.x, ev.y, 200, '#ffd23f', 0.6);
          if (!quiet) ui.toast('엘리트 처치 — 보물 상자를 주우세요');
        }
        if (boss) {
          fx.ring(ev.x, ev.y, 520, '#ff4fd8', 0.9);
          fx.flash = 1;
        }
        if (!quiet) {
          fx.addShake(boss ? 18 : ev.kind === Kind.Tank ? 5 : 1.6);
          sfx.kill();
        }
        break;
      }
      case 'shoot':
        if (!quiet) sfx.shoot();
        break;
      case 'enemyShoot':
        if (!quiet) sfx.enemyShoot();
        break;
      case 'nova':
        fx.ring(ev.x, ev.y, ev.r, ev.evo ? '#7dffa8' : '#c79bff');
        if (!quiet) {
          fx.addShake(3);
          sfx.nova();
        }
        break;
      case 'chain':
        fx.bolt(ev.pts);
        if (!quiet) sfx.chain();
        break;
      case 'blast':
        fx.ring(ev.x, ev.y, ev.r, ev.hostile ? '#ff6b3d' : '#ffd23f', 0.3);
        fx.burst(ev.x, ev.y, ev.hostile ? '#ff6b3d' : '#ffe066', ev.hostile ? 26 : 8, ev.hostile ? 360 : 220, 4, 0.4);
        if (!quiet) {
          fx.addShake(ev.hostile ? 6 : 1.2);
          sfx.blast();
        }
        break;
      case 'chest':
        fx.ring(p.x, p.y, 220, '#ffd23f', 0.6);
        fx.burst(p.x, p.y, '#ffd23f', 40, 320, 4, 0.7);
        if (!quiet) {
          ui.toast('보물 상자 — 추가 강화!');
          sfx.chest();
        }
        break;
      case 'evolve':
        fx.ring(p.x, p.y, 420, UPGRADE_META[ev.up].color, 0.9);
        fx.burst(p.x, p.y, UPGRADE_META[ev.up].color, 120, 520, 5, 1);
        if (!quiet) {
          fx.flash = 0.7;
          ui.toast(`★ 진화 — ${UPGRADE_META[ev.up].name}`);
          sfx.evolve();
        }
        break;
      case 'elite':
        if (!quiet) {
          ui.toast('⚠ 엘리트 출현 — 처치하면 보물 상자');
          sfx.warn();
        }
        break;
      case 'charge':
      case 'fuse':
        if (!quiet) sfx.warning(ev.t);
        break;
      case 'combo':
        if (!quiet) fx.text(p.x, p.y - 30, `콤보 ×${(2 + ev.tier) / 2}`, '#ffd23f', 20);
        break;
      case 'gem':
        if (!quiet) sfx.gem();
        break;
      case 'dash':
        fx.burst(p.x, p.y, '#7fe3ff', 14, 200, 4, 0.35);
        if (!quiet) sfx.dash();
        break;
      case 'playerHit':
        fx.burst(p.x, p.y, '#ff5d73', 18, 300, 4, 0.5);
        if (!quiet) {
          fx.addShake(12);
          fx.hurt = 1;
          hitstop = 0.07; // 짧게 멈춰서 맞았다는 감각을 준다(시뮬레이션 틱 수에는 영향 없음)
          fx.text(p.x, p.y - 16, `-${Math.round(ev.dmg)}`, '#ff5d73', 18);
          if (ev.combo >= 40) ui.toast(`콤보 끊김 (${ev.combo})`);
          sfx.hurt();
        }
        break;
      case 'levelup':
        fx.ring(p.x, p.y, 160, '#5df2c0', 0.5);
        if (mode === 'play') sfx.levelUp();
        break;
      case 'bossSpawn':
        if (!quiet) {
          ui.toast('⚠ 심연의 핵 출현');
          sfx.warn();
        }
        break;
      case 'wave':
        if (!quiet && sim.tick > 60) ui.toast('포위 웨이브');
        break;
      case 'win':
        if (!quiet) sfx.win();
        break;
      case 'dead':
        fx.burst(p.x, p.y, '#ffb347', 90, 460, 6, 1);
        if (!quiet) {
          fx.addShake(16);
          sfx.lose();
        }
        break;
    }
  }
}

// ───────────────────────── 판 종료 ─────────────────────────

function onFinish(): void {
  if (mode === 'menu') {
    // 배경 데모는 끝나면 새 시드로 다시 시작
    resetWorld(createSim(randomSeed()));
    return;
  }
  finished = true;
  ui.hideLevelUp();
  const r = resultOf(sim);
  const stats: [string, string][] = [
    ['생존 시간', ui.fmtTime(r.ticks * DT)],
    ['처치', r.kills.toLocaleString()],
    ['레벨', String(r.level)],
    ['최고 콤보', sim.bestCombo.toLocaleString()],
  ];

  if (mode === 'replay') {
    ui.showResult({ title: '리플레이 종료', tone: 'neutral', best: '', levels: sim.levels, score: r.score, stats, canRetry: false, canWatch: false });
    ui.setStatus('기록된 입력만으로 같은 판이 재현되었습니다.', 'ok');
    return;
  }

  lastRun = { seed, runs: recorder.runs };
  ui.showResult({
    title: r.won ? '심연의 핵 파괴!' : '불씨가 꺼졌다',
    tone: r.won ? 'win' : 'lose',
    best: updateBest(r.score),
    levels: sim.levels,
    score: r.score,
    stats,
    canRetry: true,
    canWatch: true,
  });

  if (!runId) {
    ui.setStatus('오프라인 플레이 — 서버에 연결되면 기록이 등록됩니다.', '');
    return;
  }
  ui.setStatus('서버에서 리플레이 검증 중…', '');
  const id = runId;
  runId = null;
  void api.submitRun(id, { name: playerName(), inputs: recorder.runs, score: r.score, checksum: r.checksum }).then((res) => {
    if (!finished || mode !== 'play') return; // 이미 다른 화면으로 넘어갔으면 표시하지 않는다
    if (res.ok) ui.setStatus(`검증 완료 — 현재 ${res.rank}위`, 'ok');
    else ui.setStatus(`기록 실패: ${SUBMIT_ERRORS[res.error] ?? res.error}`, 'bad');
  });
}

/** 이 브라우저의 최고 점수를 갱신하고 결과 화면에 띄울 문구를 돌려준다. */
function updateBest(score: number): string {
  if (AUTOPLAY) return ''; // 봇 플레이는 개인 기록에 남기지 않는다
  let best = 0;
  try {
    best = Number(localStorage.getItem('ember.best')) || 0;
    if (score > best) localStorage.setItem('ember.best', String(score));
  } catch {
    return '';
  }
  if (score > best) return best > 0 ? `최고 기록 갱신! (이전 ${best.toLocaleString()})` : '첫 기록';
  return `내 최고 기록 ${best.toLocaleString()}`;
}

const SUBMIT_ERRORS: Record<string, string> = {
  network: '서버에 연결할 수 없습니다',
  mismatch: '서버 재실행 결과와 일치하지 않습니다',
  too_fast: '플레이 시간보다 빨리 제출되었습니다',
  expired: '발급 후 제출 가능 시간이 지났습니다. 새 판을 시작하세요',
  already_submitted: '이미 제출된 판입니다',
  rate_limited: '요청이 너무 많습니다. 잠시 후 다시 시도하세요',
  server_busy: '서버가 바쁩니다',
  verify_error: '서버 검증이 중단되었습니다. 새 판을 시작하세요',
};

// ───────────────────────── 입력 바인딩 ─────────────────────────

function togglePause(): void {
  if (mode !== 'play' || finished) return;
  paused = !paused;
  sfx.setMusic(!paused && sim.phase === 'playing');
  ui.showPause(paused);
}

kb.onPress = (code) => {
  sfx.unlock();
  if (code === 'KeyM') ui.toast(sfx.toggleMute() ? '음소거' : '소리 켜짐');
  if (code === 'F3') debugOn = !debugOn;
  if (code === 'Escape') {
    if (mode === 'replay') enterMenu();
    else if (mode === 'play' && finished) enterMenu();
    else togglePause();
  }
  if (code === 'Enter' || code === 'NumpadEnter') {
    if (mode === 'menu' || (mode === 'play' && finished)) void startGame();
  }
  if (code === 'Space' && mode === 'replay' && !finished) {
    replaySpeed = replaySpeed >= 8 ? 1 : replaySpeed * 2;
    updateBanner();
  }
};

ui.dom.start.addEventListener('click', () => void startGame());
ui.dom.name.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    ui.dom.name.blur();
    void startGame();
  }
});
ui.dom.retry.addEventListener('click', () => void startGame());
ui.dom.watch.addEventListener('click', () => {
  if (lastRun) startReplay(lastRun.seed, lastRun.runs, '방금 플레이');
});
ui.dom.toMenu.addEventListener('click', enterMenu);
ui.dom.resume.addEventListener('click', togglePause);
ui.dom.quit.addEventListener('click', enterMenu);
setupTouch(canvas, kb, togglePause);
// 터치 기기에서는 배너를 눌러 리플레이 속도를 바꾼다
ui.dom.banner.addEventListener('click', () => {
  if (mode !== 'replay' || finished) return;
  replaySpeed = replaySpeed >= 8 ? 1 : replaySpeed * 2;
  updateBanner();
});

// 탭을 떠나면 자동 일시정지 (rAF가 멈춘 사이 적에게 맞는 일을 방지)
document.addEventListener('visibilitychange', () => {
  if (document.hidden && mode === 'play' && !paused && !finished) togglePause();
});

// ───────────────────────── 메인 루프 ─────────────────────────

let lastT = performance.now();

function loop(now: number): void {
  const dt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;

  if (!paused && !finished) advance(dt);
  if (!paused) fx.update(dt);
  sfx.setMusic(mode !== 'menu' && !paused && !finished && sim.phase === 'playing');

  const waiting = finished || paused || sim.phase === 'levelup';
  renderer.draw(sim, fx, {
    alpha: waiting ? 1 : Math.min(1, acc / DT),
    time: now / 1000,
    showPlayer: sim.phase !== 'dead',
  });
  if (mode !== 'menu') ui.updateHud(sim);
  if (hintShown && (sim.tick > 300 || mode !== 'play')) {
    hintShown = false;
    if (mode === 'play') ui.setBanner(null);
  }

  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 0.5) {
    fps = fpsFrames / fpsTime;
    fpsFrames = 0;
    fpsTime = 0;
    ui.setDebug(
      debugOn
        ? `FPS ${fps.toFixed(0)}  sim ${simMs.toFixed(2)}ms/frame\n` +
            `tick ${sim.tick}  mode ${mode}\n` +
            `enemies ${sim.enemies.length} (drawn ${renderer.drawn})\n` +
            `bullets ${sim.bullets.length}  gems ${sim.gems.length}\n` +
            `particles ${fx.particles.length}\n` +
            `replay ${recorder.runs.length / 2} runs / ${recorder.total} ticks`
        : null,
    );
  }
  requestAnimationFrame(loop);
}

try {
  ui.dom.name.value = localStorage.getItem('ember.name') ?? '';
} catch {
  /* 무시 */
}
enterMenu();
requestAnimationFrame(loop);

// 개발 빌드 전용 훅: 콘솔에서 상태를 보거나 n틱을 빨리 감는다.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__ember = {
    get sim() { return sim; },
    get mode() { return mode; },
    get seed() { return seed; },
    result: () => resultOf(sim),
    ff(n: number) {
      for (let i = 0; i < n && !finished; i++) if (!stepOnce()) break;
      fx.clear(); // 빨리 감는 동안 쌓인 이펙트는 버린다
      syncLevelUi();
    },
  };
}
