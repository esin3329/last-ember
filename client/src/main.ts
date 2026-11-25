// 게임 컨트롤러: 모드 전환(메뉴 / 플레이 / 리플레이)과 메인 루프.
//
// 메인 루프는 "고정 타임스텝 + 누적기" 구조다. 화면은 매 프레임 그리지만
// 시뮬레이션은 정확히 1/60초 단위로만 전진하고, 그때 넣은 입력을 전부 기록한다.
// 그래서 기록한 입력만 다시 넣으면 어디서든 같은 판이 재현된다.

import { botInput } from '../../shared/bot.ts';
import { DT, Kind, SEGMENT_FRAMES, SIM_VERSION, UPGRADE_META, rulesFor } from '../../shared/defs.ts';
import { type InputFrame, InputRecorder, decodeFrame, encodeFrame, expandRuns } from '../../shared/input.ts';
import { type SimEvent, type SimState, beginSegment, createSim, resultOf, segmentDue, step } from '../../shared/sim.ts';
import * as api from './api.ts';
import { registerServiceWorker } from './pwa.ts';
import { Sfx } from './audio.ts';
import { Fx } from './fx.ts';
import { Keyboard } from './keyboard.ts';
import { Renderer, kindColor } from './render.ts';
import { setupTouch } from './touch.ts';
import * as ui from './ui.ts';
import { ScoreSubmission } from './scoreSubmission.ts';
import { Tutorial } from './tutorial.ts';

type Mode = 'menu' | 'tutorial' | 'play' | 'replay';

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
let tutorial: Tutorial | null = null;
let hintShown = false;
// 개발 빌드 전용: ?autoplay 로 열면 봇이 대신 플레이한다(브라우저↔서버 검증 흐름을 손 안 대고 시험).
const AUTOPLAY = import.meta.env.DEV && new URLSearchParams(location.search).has('autoplay');

// 리플레이 상태
let replayCodes: Uint8Array = new Uint8Array(0);
let replayIdx = 0;
let replaySpeed = 1;
let replayLabel = '';
let lastRun: { seed: number; runs: number[]; segmentFrames: number; segmentSeeds: number[] } | null = null;
let replaySeeds: number[] = [];
let replaySeedIdx = 0;

// 랭킹 구간 동기화 상태
let playSegmentFrames = 0; // 0이면 구간 없음(오프라인, v2 규칙)
let segIndex = 0; // 서버에 확정할 현재 구간 번호
let segRecorder = new InputRecorder(); // 현재 구간의 입력(서버로 보내는 단위)
let segmentSeeds: number[] = []; // 이번 판에서 쓴 구간 시드(1번 구간부터). 방금 플레이 리플레이용
let syncing = false; // 서버 확정을 기다리는 동안 시뮬레이션을 멈춘다(사용자 일시정지 paused와 별개)
let syncNoticeTimer = 0;
let playEpoch = 0;
let boardRequest = 0;

// 최종 제출 상태. 화면을 떠나면 늦게 온 응답은 버려진다.
const submission = new ScoreSubmission((status) => {
  if (status.state === 'pending') {
    ui.setStatus(status.retry ? '다시 제출하는 중…' : '서버에서 리플레이 검증 중…', '');
    ui.setResubmit('pending');
  } else if (status.state === 'submitted') {
    ui.setStatus(`검증 완료 — 현재 ${status.rank}위`, 'ok');
    ui.setResubmit('hidden');
  } else {
    ui.setStatus(`기록 실패: ${SUBMIT_ERRORS[status.error] ?? status.error}`, 'bad');
    ui.setResubmit(status.retry ? 'ready' : 'hidden');
  }
});

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
  tutorial = null;
  hintShown = false;
  sim = newSim;
  playEpoch++; // 이전 화면에서 시작한 발급·리플레이·구간 동기화·제출 응답을 무시한다.
  starting = false;
  ui.dom.ranked.disabled = false;
  ui.dom.retry.disabled = false;
  ui.dom.startStatus.classList.add('hidden');
  ui.dom.startStatus.textContent = '';
  syncing = false;
  window.clearTimeout(syncNoticeTimer);
  submission.discard();
  ui.setResubmit('hidden');
  fx.clear();
  kb.reset();
  acc = 0;
  hitstop = 0;
  paused = false;
  finished = false;
  levelUiKey = '';
  ui.hideLevelUp();
  ui.hideResult();
  ui.dom.tutorialComplete.classList.add('hidden');
  ui.showPause(false);
}

function setMode(next: Mode): void {
  mode = next;
  document.body.classList.toggle('playing', interactive());
  document.body.classList.toggle('tutorial', next === 'tutorial');
  ui.dom.replayExit.classList.toggle('hidden', next !== 'replay');
}

function interactive(): boolean {
  return mode === 'play' || mode === 'tutorial';
}

function enterMenu(): void {
  setMode('menu');
  resetWorld(createSim(randomSeed()));
  ui.showMenu(true);
  ui.showHud(false);
  ui.setBanner(null);
}

function startTutorial(): void {
  armBack();
  sfx.unlock();
  const lesson = new Tutorial();
  setMode('tutorial');
  resetWorld(lesson.sim);
  tutorial = lesson;
  ui.showMenu(false);
  ui.showHud(true);
  ui.dom.runMode.textContent = '튜토리얼 · 랭킹 미기록';
  showTutorialStage(lesson.stage);
}

function showTutorialStage(stage: Tutorial['stage']): void {
  const touch = document.body.classList.contains('touch') || matchMedia('(pointer: coarse)').matches;
  switch (stage) {
    case 'move':
      ui.setBanner(touch ? '1/5 이동: 화면을 끌어 움직이세요' : '1/5 이동: WASD 또는 스틱으로 움직이세요');
      break;
    case 'dash':
      ui.setBanner(touch ? '2/5 회피: 대시 버튼을 누르세요' : '2/5 회피: Space 또는 A로 대시하세요');
      break;
    case 'attack':
      ui.setBanner('3/5 자동 공격: 가까운 적을 자동으로 공격합니다');
      break;
    case 'collect':
      ui.setBanner('4/5 불씨 획득: 빛나는 불씨에 다가가세요');
      break;
    case 'upgrade':
      ui.setBanner('5/5 강화: 카드 한 장을 고르세요');
      break;
    case 'complete':
      finished = true;
      ui.hideLevelUp();
      ui.setBanner(null);
      ui.dom.tutorialComplete.classList.remove('hidden');
      ui.dom.tutorialDone.focus();
      break;
  }
}

async function startGame(): Promise<void> {
  if (starting) return;
  armBack();
  const epoch = playEpoch;
  sfx.unlock();
  starting = true;
  ui.dom.ranked.disabled = true;
  ui.dom.retry.disabled = true;
  ui.dom.startStatus.textContent = '랭킹 서버에 연결 중… 튜토리얼은 바로 시작할 수 있습니다.';
  ui.dom.startStatus.classList.remove('hidden');
  try {
    localStorage.setItem('ember.name', ui.dom.name.value);
  } catch {
    /* 저장소를 사용할 수 없어도 플레이한다 */
  }
  const issued = await api.issueRun();
  if (epoch !== playEpoch) return;
  const run = issued.kind === 'ok' && issued.run.simVersion === SIM_VERSION && issued.run.segmentFrames === SEGMENT_FRAMES ? issued.run : null;
  runId = run ? run.runId : null;
  seed = run ? run.seed : randomSeed();
  playSegmentFrames = run ? run.segmentFrames : 0;
  ui.dom.runMode.textContent = run ? '랭킹 도전' : '오프라인 · 랭킹 미기록';
  recorder = new InputRecorder();
  segRecorder = new InputRecorder();
  segmentSeeds = [];
  segIndex = 0;
  setMode('play');
  resetWorld(createSim(seed, true, playSegmentFrames));
  ui.showMenu(false);
  ui.showHud(true);
  // 처음 몇 초 동안만 조작 안내를 띄운다
  hintShown = true;
  ui.setBanner(document.body.classList.contains('touch') || matchMedia('(pointer: coarse)').matches ? '화면을 끌어 이동 · 대시 버튼으로 회피 · 공격은 자동' : 'WASD 이동 · Space 대시 · 공격은 자동');
  if (!run) {
    const reason = issued.kind === 'quota'
      ? (ISSUE_ERRORS[issued.error] ?? '랭킹 판을 받지 못했습니다')
      : '랭킹 서버를 사용할 수 없습니다';
    ui.toast(`${reason} — 오프라인으로 시작합니다`);
  }
}

function startReplay(replaySeed: number, runs: number[], label: string, segmentFrames: number, segmentSeeds: number[]): void {
  sfx.unlock();
  armBack();
  replayCodes = expandRuns(runs);
  replayIdx = 0;
  replaySeeds = segmentSeeds;
  replaySeedIdx = 0;
  replaySpeed = 1;
  replayLabel = label;
  setMode('replay');
  resetWorld(createSim(replaySeed, true, segmentFrames));
  ui.showMenu(false);
  ui.showHud(true);
  ui.dom.runMode.textContent = '리플레이';
  updateBanner();
}

function updateBanner(): void {
  ui.setBanner(`${replayLabel} · ${replaySpeed}배속 — 배너 터치 또는 Space로 속도 변경`);
}

async function watchFromBoard(entry: api.BoardEntry): Promise<void> {
  if (starting) return;
  armBack();
  const epoch = playEpoch;
  const data = await api.fetchReplay(entry.runId);
  if (epoch !== playEpoch || starting) return;
  // v2(구 랭킹)와 v3(구간 시드) 기록을 모두 재생한다. 모르는 규칙 버전은 재생하지 않는다.
  const rules = data ? rulesFor(data.simVersion) : null;
  if (!data || !rules) {
    ui.toast('리플레이를 불러올 수 없습니다');
    return;
  }
  startReplay(data.seed, data.inputs, `${data.name} (${data.score.toLocaleString()}점)`, rules.segmentFrames, data.segmentSeeds);
}

async function refreshBoard(): Promise<void> {
  const request = ++boardRequest;
  const entries = await api.fetchBoard();
  if (request !== boardRequest) return;
  ui.setNet(entries ? 'on' : 'off');
  ui.renderBoard(entries, (e) => void watchFromBoard(e));
}

// ───────────────────────── 시뮬레이션 진행 ─────────────────────────

/** 한 틱 진행. 입력을 기다려야 해서 진행할 수 없으면 false. */
function stepOnce(): boolean {
  if (syncing) return false;
  // 구간 경계: 서버가 이전 구간 입력을 확정해 주기 전에는 한 프레임도 진행하지 않는다.
  if (mode === 'play' && segmentDue(sim)) {
    void syncSegment();
    return false;
  }
  if (mode === 'play' && AUTOPLAY) {
    botInput(sim, frame);
    recordFrame();
    step(sim, frame);
  } else if (mode === 'play' || tutorial) {
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
    if (tutorial) {
      const previous = tutorial.stage;
      tutorial.step(frame);
      if (tutorial.stage !== previous) showTutorialStage(tutorial.stage);
    } else {
      recordFrame();
      step(sim, frame);
    }
  } else if (mode === 'replay') {
    if (replayIdx >= replayCodes.length) return false;
    if (segmentDue(sim)) {
      if (replaySeedIdx >= replaySeeds.length) return false;
      beginSegment(sim, replaySeeds[replaySeedIdx++]);
    }
    step(sim, decodeFrame(replayCodes[replayIdx++], frame));
  } else {
    step(sim, botInput(sim, frame));
  }

  handleEvents(sim.events);
  if (sim.phase === 'dead' || sim.phase === 'won') onFinish();
  return true;
}

/** 한 입력 프레임을 판 전체 기록과 현재 구간 기록에 남긴다. */
function recordFrame(): void {
  const code = encodeFrame(frame);
  recorder.push(code);
  segRecorder.push(code);
}

/**
 * 구간 경계 처리: 서버 판이면 이번 구간 입력을 확정하고 다음 시드를 받는다(그동안 시뮬레이션은 멈춘다).
 * 서버에 닿지 않거나 기한을 넘기면 로컬 시드로 이어가며, 그 판은 기록되지 않는다.
 */
async function syncSegment(): Promise<void> {
  if (syncing) return;
  syncing = true;
  const epoch = playEpoch;
  let nextSeed = randomSeed();
  const id = runId;
  if (id) {
    // 왕복이 짧으면 안내를 띄우지 않는다.
    syncNoticeTimer = window.setTimeout(() => ui.setBanner('서버와 동기화 중…'), 500);
    const res = await api.commitSegment(id, segIndex, segRecorder.runs, false);
    if (epoch !== playEpoch) return; // 그 사이 다른 화면으로 넘어갔다
    window.clearTimeout(syncNoticeTimer);
    ui.setBanner(null);
    if (res.ok && res.next) {
      nextSeed = res.next.seed;
      segIndex = res.next.index;
    } else {
      runId = null;
      ui.dom.runMode.textContent = '랭킹 연결 끊김 · 미기록';
      const reason = res.ok ? '서버 응답이 올바르지 않습니다' : (SYNC_ERRORS[res.error] ?? res.error);
      ui.toast(`${reason} — 로컬로 이어가며 이번 판은 기록되지 않습니다`);
    }
  }
  beginSegment(sim, nextSeed);
  segmentSeeds.push(nextSeed | 0);
  segRecorder = new InputRecorder();
  syncing = false;
  acc = 0;
}

function advance(dt: number): void {
  if (syncing) return;
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
  if (!interactive() || finished || sim.phase !== 'levelup') {
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
    // 배경만 재시작한다. 메뉴에서 진행 중인 랭킹 발급·리플레이 요청은 유지한다.
    sim = createSim(randomSeed());
    fx.clear();
    hitstop = 0;
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
    ui.dom.replayExit.classList.add('hidden');
    ui.showResult({ title: '리플레이 종료', tone: 'neutral', best: '', levels: sim.levels, score: r.score, stats, canRetry: false, canWatch: false });
    ui.setStatus('기록된 입력만으로 같은 판이 재현되었습니다.', 'ok');
    return;
  }

  lastRun = { seed, runs: recorder.runs, segmentFrames: playSegmentFrames, segmentSeeds: [...segmentSeeds] };
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
    ui.setStatus('이 판은 랭킹에 등록되지 않습니다. 최고 점수는 이 브라우저에 저장됩니다.', '');
    return;
  }
  // 결과·이름·체크섬과 마지막 구간 입력을 지금 값으로 고정한다. 재시도해도 같은 값으로만 제출된다.
  const id = runId;
  runId = null;
  const finalSegment = { index: segIndex, runs: segRecorder.runs };
  const payload = { name: playerName(), score: r.score, checksum: r.checksum };
  const finalState: api.FinalSubmitState = { finalCommitted: false }; // 재시도 사이에 최종 구간 ACK를 기억한다
  submission.start(async () => {
    const verified = await api.submitRun(id, finalSegment, payload, finalState);
    // 결과 화면을 이미 떠났더라도 검증된 기록으로 리더보드를 갱신한다.
    if (verified.ok) void refreshBoard();
    return verified;
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
  timeout: '구간 입력이 너무 늦게 도착해 이번 판은 기록되지 않았습니다',
  already_submitted: '이미 제출된 판입니다',
  abandoned: '새 판 발급으로 이 판이 무효화되었습니다. 새 판을 시작하세요',
  rate_limited: '요청이 너무 많습니다. 잠시 후 다시 시도하세요',
  server_busy: '검증 서버가 바빠 이번 판은 기록되지 않았습니다',
  verify_error: '검증 중 서버 오류로 이번 판은 기록되지 않았습니다',
  no_session: '브라우저 세션이 없습니다. 새 판을 시작하세요',
  not_owner: '이 브라우저가 시작한 판이 아닙니다',
  segment_conflict: '서버에 저장된 입력과 달라 이번 판은 기록되지 않습니다',
  run_closed: '이미 종료된 판입니다. 새 판을 시작하세요',
};

/** 랭킹 판을 받지 못했을 때(서버는 응답했지만 한도 등) 보여 줄 안내. */
const ISSUE_ERRORS: Record<string, string> = {
  quota_exceeded: '30분 발급 한도에 도달했습니다',
  ip_quota_exceeded: '이 네트워크의 발급 한도에 도달했습니다',
  server_busy: '서버가 바쁩니다',
};

/** 구간 동기화가 끊겨 로컬로 이어갈 때의 이유. */
const SYNC_ERRORS: Record<string, string> = {
  network: '서버에 연결할 수 없습니다',
  timeout: '일시정지나 지연이 길어 서버 기한을 넘겼습니다',
  expired: '발급 기한이 지났습니다',
  abandoned: '새 판 발급으로 이 판이 무효화되었습니다',
};

// ───────────────────────── 입력 바인딩 ─────────────────────────

function togglePause(): void {
  if (!interactive() || finished) return;
  paused = !paused;
  kb.reset();
  ui.dom.pauseStatus.classList.toggle('hidden', mode !== 'play' || !runId);
  if (!paused) armBack();
  sfx.setMusic(!paused && sim.phase === 'playing');
  ui.showPause(paused);
}

// 시작 입력에서 두 항목을 미리 쌓는다. popstate에서 다시 쌓으면 다음 뒤로가기에서 건너뛸 수 있다.
let backDepth = history.state?.lastEmberBack ?? 0;

function armBack(): void {
  while (backDepth < 2) {
    history.pushState({ lastEmberBack: backDepth + 1 }, '');
    backDepth++;
  }
}

function returnToMenu(): void {
  enterMenu();
  if (backDepth > 0) history.go(-backDepth);
}

window.addEventListener('popstate', (event) => {
  const previousDepth = backDepth;
  backDepth = event.state?.lastEmberBack ?? 0;
  if (backDepth >= previousDepth) return; // 앞으로 가기는 화면을 복원하지 않는다.
  if (backDepth === 1 && interactive() && !finished && !paused) {
    togglePause();
  } else if (mode !== 'menu' || starting) {
    returnToMenu();
  } else {
    playEpoch++; // 메뉴를 유지하면서 아직 도착하지 않은 리플레이 응답을 무효화한다.
    if (backDepth > 0) history.go(-backDepth);
  }
});

kb.onPress = (code) => {
  sfx.unlock();
  if (code === 'KeyM') ui.toast(sfx.toggleMute() ? '음소거' : '소리 켜짐');
  if (code === 'F3') debugOn = !debugOn;
  if (code === 'Escape') {
    if (mode === 'replay' || (interactive() && finished) || starting) returnToMenu();
    else togglePause();
  }
  if (code === 'Enter' || code === 'NumpadEnter') {
    if (mode === 'menu') startTutorial();
    else if (mode === 'tutorial' && finished) returnToMenu();
    else if (mode === 'play' && finished) void startGame();
  }
  if (code === 'Space' && mode === 'replay' && !finished) {
    replaySpeed = replaySpeed >= 8 ? 1 : replaySpeed * 2;
    updateBanner();
  }
};

ui.dom.tutorial.addEventListener('click', startTutorial);
ui.dom.tutorialDone.addEventListener('click', returnToMenu);
ui.dom.ranked.addEventListener('click', () => void startGame());
ui.dom.name.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    ui.dom.name.blur();
    void startGame();
  }
});
ui.dom.retry.addEventListener('click', () => void startGame());
ui.dom.watch.addEventListener('click', () => {
  if (lastRun) startReplay(lastRun.seed, lastRun.runs, '방금 플레이', lastRun.segmentFrames, lastRun.segmentSeeds);
});
ui.dom.toMenu.addEventListener('click', returnToMenu);
ui.dom.replayExit.addEventListener('click', returnToMenu);
ui.dom.resume.addEventListener('click', togglePause);
ui.dom.quit.addEventListener('click', returnToMenu);
setupTouch(canvas, kb, togglePause);
// 게임패드가 끊기면 자동 일시정지. 이미 일시정지면 그대로 둔다(랭킹 동기화 대기와는 별개 상태).
kb.onGamepadDisconnect = () => {
  if (interactive() && !paused && !finished) togglePause();
};
ui.dom.resubmit.addEventListener('click', () => submission.retry());
// 터치 기기에서는 배너를 눌러 리플레이 속도를 바꾼다
ui.dom.banner.addEventListener('click', () => {
  if (mode !== 'replay' || finished) return;
  replaySpeed = replaySpeed >= 8 ? 1 : replaySpeed * 2;
  updateBanner();
});

// 탭을 떠나면 자동 일시정지 (rAF가 멈춘 사이 적에게 맞는 일을 방지)
document.addEventListener('visibilitychange', () => {
  if (document.hidden && interactive() && !paused && !finished) togglePause();
});

// ───────────────────────── 메인 루프 ─────────────────────────

let lastT = performance.now();

function loop(now: number): void {
  const dt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;

  if (!paused && !finished) advance(dt);
  if (!paused) fx.update(dt);
  sfx.setMusic(mode !== 'menu' && !paused && !finished && !syncing && sim.phase === 'playing');

  const waiting = finished || paused || syncing || sim.phase === 'levelup';
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
registerServiceWorker();
returnToMenu();
void refreshBoard();
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
