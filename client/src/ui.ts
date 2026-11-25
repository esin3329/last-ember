// DOM 기반 UI (메뉴, HUD, 레벨업 카드, 결과 화면).
// 글자가 많은 UI는 캔버스보다 DOM이 선명하고 접근성도 좋다.
// HUD는 매 프레임 호출되므로 값이 바뀔 때만 DOM을 건드린다.

import { BOSS_TICK, DASH_CD, DT, EVOLUTIONS, Kind, UPGRADE_META, comboTier, maxLevel } from '../../shared/defs.ts';
import type { SimState } from '../../shared/sim.ts';
import type { BoardEntry } from './api.ts';

const ICON_NAMES = [
  'bolt', 'orbit', 'nova', 'chain', 'might', 'haste', 'swift', 'vital', 'magnet', 'regen',
  'sun-lance', 'tempest', 'bloom', 'thunder',
];

function upgradeIcon(up: number): HTMLImageElement {
  const icon = new Image(44, 44);
  icon.src = new URL(`../assets/icons/runtime/${ICON_NAMES[up]}.png`, import.meta.url).href;
  icon.alt = UPGRADE_META[up].name;
  return icon;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  hud: $('hud'), xp: $('xpfill'), hp: $('hpfill'), hpText: $('hptext'), level: $('level'),
  dash: $('dashfill'), timer: $('timer'), phase: $('phase'), score: $('score'), kills: $('kills'),
  boss: $('boss'), bossFill: $('bossfill'), build: $('build'),
  combo: $('combo'), mult: $('mult'), comboBox: $('combo-box'),
  banner: $('banner'), toast: $('toast'),
  menu: $('menu'), name: $<HTMLInputElement>('name'), practice: $<HTMLButtonElement>('start'),
  ranked: $<HTMLButtonElement>('ranked-start'), startStatus: $('start-status'),
  net: $('net'), board: $('board'), runMode: $('run-mode'), replayExit: $('replay-exit'),
  levelup: $('levelup'), cards: $('cards'),
  pause: $('pause'), pauseStatus: $('pause-status'), resume: $('resume'), quit: $('quit'),
  result: $('result'), resultTitle: $('result-title'), resultScore: $('result-score'),
  resultStats: $('result-stats'), resultStatus: $('result-status'),
  resultBest: $('result-best'), resultBuild: $('result-build'),
  retry: $<HTMLButtonElement>('retry'), watch: $('watch'), toMenu: $('tomenu'),
  resubmit: $<HTMLButtonElement>('resubmit'),
  debug: $('debug'),
};

export const dom = el;

function show(node: HTMLElement, on: boolean): void {
  node.classList.toggle('hidden', !on);
}

export function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── HUD ──
const last: Record<string, string | number> = {};
function setText(key: string, node: HTMLElement, value: string | number): void {
  if (last[key] === value) return;
  last[key] = value;
  node.textContent = String(value);
}
function setScale(key: string, node: HTMLElement, ratio: number): void {
  const v = Math.round(Math.max(0, Math.min(1, ratio)) * 500) / 500;
  if (last[key] === v) return;
  last[key] = v;
  node.style.transform = `scaleX(${v})`;
}

export function showHud(on: boolean): void {
  show(el.hud, on);
}

export function updateHud(s: SimState): void {
  const p = s.player;
  setText('level', el.level, p.level);
  setText('hp', el.hpText, `${Math.max(0, Math.ceil(p.hp))} / ${p.maxHp}`);
  setScale('hpbar', el.hp, p.hp / p.maxHp);
  const xp = Math.round((p.xp / p.xpNext) * 200) / 2;
  if (last.xp !== xp) {
    last.xp = xp;
    el.xp.style.width = `${xp}%`;
  }
  setScale('dash', el.dash, 1 - p.dashCd / DASH_CD);
  const ready = p.dashCd === 0 ? 1 : 0;
  if (last.dashReady !== ready) {
    last.dashReady = ready;
    el.dash.parentElement!.classList.toggle('ready', ready === 1);
  }
  setText('timer', el.timer, fmtTime(s.tick * DT));
  setText('score', el.score, s.score.toLocaleString());
  setText('kills', el.kills, s.kills.toLocaleString());
  setText('combo', el.combo, s.combo);
  const tier = comboTier(s.combo);
  setText('mult', el.mult, tier > 0 ? `×${(2 + tier) / 2}` : '');
  if (last.hot !== tier) {
    last.hot = tier;
    el.comboBox.classList.toggle('hot', tier > 0);
  }

  const phase = s.bossSpawned ? '보스전 — 심연의 핵을 부숴라' : `보스까지 ${fmtTime((BOSS_TICK - s.tick) * DT + 0.99)}`;
  setText('phase', el.phase, phase);
  const alert = s.bossSpawned ? 1 : 0;
  if (last.alert !== alert) {
    last.alert = alert;
    el.phase.classList.toggle('alert', alert === 1);
    show(el.boss, alert === 1);
  }
  if (s.bossSpawned) {
    let ratio = 0;
    for (const e of s.enemies) {
      if (e.kind === Kind.Boss) ratio = e.hp / e.maxHp;
    }
    setScale('boss', el.bossFill, ratio);
  }

  const buildKey = s.levels.join('');
  if (last.build !== buildKey) {
    last.build = buildKey;
    el.build.replaceChildren(...buildChips(s.levels));
  }
}

/** 보유한 강화 목록을 칩으로 만든다 (HUD와 결과 화면 공용). */
function buildChips(levels: number[]): HTMLElement[] {
  return levels.flatMap((lv, i) => {
    if (lv === 0) return [];
    const meta = UPGRADE_META[i];
    const chip = document.createElement('div');
    chip.className = meta.evo ? 'chip evo' : 'chip';
    const icon = upgradeIcon(i);
    chip.title = meta.name;
    const name = document.createElement('span');
    name.textContent = meta.name;
    const small = document.createElement('small');
    small.textContent = meta.evo ? '진화' : lv >= maxLevel(i) ? 'MAX' : `Lv${lv}`;
    chip.append(icon, name, small);
    return [chip];
  });
}

// ── 메뉴 / 리더보드 ──
export function showMenu(on: boolean): void {
  show(el.menu, on);
}

export function setNet(state: 'on' | 'off' | 'wait'): void {
  el.net.className = `net ${state === 'wait' ? '' : state}`;
  el.net.textContent = state === 'on' ? '서버 온라인' : state === 'off' ? '오프라인 (기록 안 됨)' : '연결 확인 중';
}

export function renderBoard(entries: BoardEntry[] | null, onReplay: (e: BoardEntry) => void): void {
  if (!entries || entries.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = entries ? '아직 기록이 없습니다. 첫 기록의 주인공이 되어 보세요.' : '서버에 연결할 수 없어 리더보드를 불러오지 못했습니다.';
    el.board.replaceChildren(li);
    return;
  }
  el.board.replaceChildren(
    ...entries.map((e) => {
      const li = document.createElement('li');
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = String(e.rank);
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = e.name; // textContent라서 이름에 태그가 있어도 실행되지 않는다
      if (e.won) {
        const crown = document.createElement('span');
        crown.className = 'crown';
        crown.textContent = '★';
        crown.title = '보스 처치';
        who.append(crown);
      }
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `Lv${e.level} · ${fmtTime(e.seconds)}`;
      const pts = document.createElement('span');
      pts.className = 'pts';
      pts.textContent = e.score.toLocaleString();
      const btn = document.createElement('button');
      btn.textContent = '▶';
      btn.title = `${e.name}의 리플레이 보기`;
      btn.setAttribute('aria-label', btn.title);
      btn.addEventListener('click', () => onReplay(e));
      li.append(rank, who, meta, pts, btn);
      return li;
    }),
  );
}

// ── 레벨업 ──
export function showLevelUp(s: SimState, onPick: (index: number) => void): void {
  el.cards.replaceChildren(
    ...s.choices.map((up, i) => {
      const meta = UPGRADE_META[up];
      const cur = s.levels[up];
      const card = document.createElement('button');
      card.className = meta.evo ? 'card evo' : 'card';
      card.style.setProperty('--c', meta.color);
      const key = document.createElement('kbd');
      key.className = 'key';
      key.textContent = String(i + 1);
      const icon = upgradeIcon(up);
      icon.className = 'icon';
      const kind = document.createElement('div');
      kind.className = 'kind';
      kind.textContent = meta.evo ? '★ 진화' : cur === 0 ? (meta.weapon ? '새 무기' : '새 능력') : `Lv ${cur} → ${cur + 1}`;
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = meta.name;
      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = meta.desc(cur + 1);
      const pips = document.createElement('div');
      pips.className = 'pips';
      for (let k = 0; k < maxLevel(up); k++) {
        const pip = document.createElement('span');
        if (k < cur) pip.className = 'on';
        else if (k === cur) pip.className = 'new';
        pips.append(pip);
      }
      card.append(key, icon, kind, title, desc, pips);
      // 일반 무기 카드에는 진화 조건을 작게 알려 준다 (빌드 목표 제시)
      const recipe = EVOLUTIONS.find((e) => e.weapon === up);
      if (recipe) {
        const hint = document.createElement('div');
        hint.className = 'recipe';
        hint.textContent = `진화: MAX + ${UPGRADE_META[recipe.passive].name} Lv2 → ${UPGRADE_META[recipe.evo].name}`;
        card.append(hint);
      }
      card.addEventListener('click', () => onPick(i));
      return card;
    }),
  );
  show(el.levelup, true);
}

export function hideLevelUp(): void {
  show(el.levelup, false);
}

// ── 일시정지 / 결과 ──
export function showPause(on: boolean): void {
  el.levelup.inert = on;
  show(el.pause, on);
}

export interface ResultView {
  title: string;
  tone: 'win' | 'lose' | 'neutral';
  best: string;
  levels: number[];
  score: number;
  stats: [string, string][];
  canRetry: boolean;
  canWatch: boolean;
}

export function showResult(v: ResultView): void {
  el.resultTitle.textContent = v.title;
  el.resultTitle.className = v.tone;
  el.resultBest.textContent = v.best;
  el.resultBuild.replaceChildren(...buildChips(v.levels));
  el.resultScore.textContent = v.score.toLocaleString();
  el.resultStats.replaceChildren(
    ...v.stats.map(([k, val]) => {
      const div = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = val;
      div.append(dt, dd);
      return div;
    }),
  );
  show(el.retry, v.canRetry);
  show(el.watch, v.canWatch);
  setResubmit('hidden');
  setStatus('', '');
  show(el.result, true);
}

export function hideResult(): void {
  show(el.result, false);
}

export function setResubmit(state: 'hidden' | 'ready' | 'pending'): void {
  show(el.resubmit, state !== 'hidden');
  el.resubmit.disabled = state === 'pending';
}

export function setStatus(text: string, kind: '' | 'ok' | 'bad'): void {
  el.resultStatus.textContent = text;
  el.resultStatus.className = kind;
}

// ── 기타 ──
export function toast(text: string): void {
  el.toast.textContent = text;
  el.toast.classList.remove('show');
  void el.toast.offsetWidth; // 애니메이션 재시작
  el.toast.classList.add('show');
}

export function setBanner(text: string | null): void {
  show(el.banner, text !== null);
  if (text !== null) el.banner.textContent = text;
}

export function setDebug(text: string | null): void {
  show(el.debug, text !== null);
  if (text !== null) el.debug.textContent = text;
}
