// 게임패드 입력 (W3C Standard Gamepad 매핑 전용).
// 시뮬레이션 입력은 이동 8방향 + 대시 + 선택(0~2)뿐이므로, 스틱·D-pad는 키보드와 같은 -1|0|1 축으로 양자화하고
// 대시/선택/일시정지는 "눌린 순간"(edge)만 콜백으로 낸다. 폴링 횟수와 무관하게 한 번 누른 것은 정확히 한 번만 나간다.
// DOM에 의존하지 않아 Node에서 가짜 패드로 시험할 수 있다. 실제 폴링은 keyboard.ts가 한다.

export interface PadButtonLike {
  pressed: boolean;
  value: number;
}

export interface PadLike {
  connected: boolean;
  mapping: string;
  id?: string;
  buttons: ArrayLike<PadButtonLike>;
  axes: ArrayLike<number>;
}

export interface GamepadHandlers {
  dash(): void;
  /** 레벨업 선택지 번호 0~2 */
  choice(index: number): void;
  pause(): void;
  /** 사용 중이던 패드가 사라졌을 때(한 번만). 이동 축은 이미 0으로 돌아가 있다. */
  disconnect(): void;
}

// Standard Gamepad 버튼 번호
const BTN_A = 0;
const BTN_B = 1;
const BTN_X = 2;
const BTN_Y = 3;
const BTN_RB = 5;
const BTN_RT = 7;
const BTN_START = 9;
const BTN_UP = 12;
const BTN_DOWN = 13;
const BTN_LEFT = 14;
const BTN_RIGHT = 15;
const BUTTON_COUNT = 16;

const DASH_BUTTONS = [BTN_A, BTN_RB, BTN_RT];
/** 카드는 왼쪽부터 1·2·3이고 키보드 1·2·3에 대응한다: X → 0, Y → 1, B → 2 */
const CHOICE_BUTTONS = [BTN_X, BTN_Y, BTN_B];

// 스틱 데드존: 들어올 때는 크게, 풀릴 때는 작게 잡아 경계에서 입력이 깜박이지 않게 한다.
export const STICK_ENGAGE = 0.35;
export const STICK_RELEASE = 0.25;
// 방향 섹터(45°) 경계를 넘더라도 이 각도(도)만큼은 이전 방향을 유지한다.
const SECTOR_HYSTERESIS_DEG = 6;

// 각도 = atan2(y, x), y는 아래가 양수(화면/키보드 my와 같은 방향). 0°=오른쪽, 시계 방향.
const DIRS: readonly (readonly [number, number])[] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

function isDown(b: PadButtonLike | undefined): boolean {
  return b !== undefined && (b.pressed || b.value > 0.5);
}

function axis(pad: PadLike, i: number): number {
  const v = pad.axes[i];
  return Number.isFinite(v) ? v : 0;
}

function usable(pad: PadLike | null | undefined): pad is PadLike {
  return pad != null && pad.connected && pad.mapping === 'standard';
}

export class GamepadInput {
  mx = 0;
  my = 0;

  private activeIndex = -1;
  private activeId: string | undefined;
  private prev = new Array<boolean>(BUTTON_COUNT).fill(false);
  private seedNext = false;
  private engaged = false;
  private dir = -1;

  private readonly h: GamepadHandlers;

  constructor(handlers: GamepadHandlers) {
    this.h = handlers;
  }

  get connected(): boolean {
    return this.activeIndex >= 0;
  }

  /**
   * 다음 poll은 눌린 상태를 기준선으로만 삼고 edge를 내지 않는다.
   * 탭/창 복귀처럼 폴링이 끊겼다가 이어질 때, 그 사이 바뀐 버튼이 가짜 입력이 되는 것을 막는다.
   */
  resync(): void {
    this.seedNext = true;
  }

  poll(pads: ArrayLike<PadLike | null> | null | undefined): void {
    const list = pads ?? [];

    if (this.activeIndex >= 0) {
      const cur = list[this.activeIndex];
      if (!usable(cur) || cur.id !== this.activeId) {
        this.detach();
        this.h.disconnect();
      }
    }

    if (this.activeIndex < 0) {
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (usable(p)) {
          this.activeIndex = i;
          this.activeId = p.id;
          this.seedNext = true; // 처음 잡은 패드에서 이미 눌려 있던 버튼은 입력이 아니다
          break;
        }
      }
      if (this.activeIndex < 0) return;
    }

    const pad = list[this.activeIndex] as PadLike;
    this.readMove(pad);

    const now = this.prev.slice();
    for (let i = 0; i < BUTTON_COUNT; i++) now[i] = isDown(pad.buttons[i]);

    if (this.seedNext) {
      this.seedNext = false;
    } else {
      const was = this.prev;
      if (DASH_BUTTONS.some((b) => now[b]) && !DASH_BUTTONS.some((b) => was[b])) this.h.dash();
      for (let c = 0; c < CHOICE_BUTTONS.length; c++) {
        const b = CHOICE_BUTTONS[c];
        if (now[b] && !was[b]) this.h.choice(c);
      }
      if (now[BTN_START] && !was[BTN_START]) this.h.pause();
    }
    this.prev = now;
  }

  private detach(): void {
    this.activeIndex = -1;
    this.activeId = undefined;
    this.prev.fill(false);
    this.seedNext = false;
    this.mx = 0;
    this.my = 0;
    this.engaged = false;
    this.dir = -1;
  }

  private readMove(pad: PadLike): void {
    // D-pad가 눌려 있으면 스틱보다 우선한다. 반대 방향이 함께 눌리면 키보드처럼 상쇄.
    const dx = (isDown(pad.buttons[BTN_RIGHT]) ? 1 : 0) - (isDown(pad.buttons[BTN_LEFT]) ? 1 : 0);
    const dy = (isDown(pad.buttons[BTN_DOWN]) ? 1 : 0) - (isDown(pad.buttons[BTN_UP]) ? 1 : 0);
    if (dx !== 0 || dy !== 0) {
      this.mx = dx;
      this.my = dy;
      this.engaged = false;
      this.dir = -1;
      return;
    }
    this.readStick(axis(pad, 0), axis(pad, 1));
  }

  private readStick(x: number, y: number): void {
    const mag = Math.hypot(x, y);
    this.engaged = mag >= (this.engaged ? STICK_RELEASE : STICK_ENGAGE);
    if (!this.engaged) {
      this.dir = -1;
      this.mx = 0;
      this.my = 0;
      return;
    }
    const deg = (Math.atan2(y, x) * 180) / Math.PI; // -180..180
    let dir = ((Math.round(deg / 45) % 8) + 8) % 8;
    if (this.dir >= 0 && dir !== this.dir) {
      let diff = Math.abs(deg - this.dir * 45) % 360;
      if (diff > 180) diff = 360 - diff;
      if (diff < 22.5 + SECTOR_HYSTERESIS_DEG) dir = this.dir;
    }
    this.dir = dir;
    this.mx = DIRS[dir][0];
    this.my = DIRS[dir][1];
  }
}
