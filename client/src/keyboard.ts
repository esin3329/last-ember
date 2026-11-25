// 키보드 입력. 눌린 키 집합에서 이동 축을 읽고, 대시/선택은 "눌린 순간"만 큐에 넣는다.
// 게임패드(gamepad.ts)도 같은 큐/축으로 합류한다. 이동 우선순위: 키보드 > 게임패드 > 터치.

import { GamepadInput } from './gamepad.ts';

const BLOCK_SCROLL = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

export class Keyboard {
  private down = new Set<string>();
  dashQueued = false;
  choiceQueued = -1;
  // 터치 조이스틱이 채우는 축 값 (touch.ts)
  touchMx = 0;
  touchMy = 0;
  onPress: (code: string) => void = () => {};
  // 사용 중이던 게임패드가 끊겼을 때 한 번 호출된다 (이동 입력은 이미 0). 일시정지 여부 판단은 호출자 몫.
  onGamepadDisconnect: () => void = () => {};
  private readonly pad = new GamepadInput({
    dash: () => {
      this.dashQueued = true;
    },
    choice: (i) => {
      this.choiceQueued = i;
    },
    // 일시정지는 Esc와 같은 경로를 탄다
    pause: () => this.onPress('Escape'),
    disconnect: () => this.onGamepadDisconnect(),
  });
  private padLastT = 0;

  constructor() {
    window.addEventListener('keydown', (e) => {
      // 이름 입력과 포커스된 버튼의 기본 키보드 동작을 보존한다.
      if (e.target instanceof HTMLInputElement ||
          (e.target instanceof HTMLButtonElement && (e.key === 'Enter' || e.key === ' '))) return;
      if (BLOCK_SCROLL.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.down.add(e.code);
      if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.dashQueued = true;
      if (e.code === 'Digit1' || e.code === 'Numpad1') this.choiceQueued = 0;
      if (e.code === 'Digit2' || e.code === 'Numpad2') this.choiceQueued = 1;
      if (e.code === 'Digit3' || e.code === 'Numpad3') this.choiceQueued = 2;
      this.onPress(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    // 창이 포커스를 잃으면 keyup을 못 받으므로 전부 뗀 것으로 처리한다
    window.addEventListener('blur', () => {
      this.down.clear();
      this.pad.resync();
    });
    window.addEventListener('focus', () => this.pad.resync());
    if (typeof navigator.getGamepads === 'function') requestAnimationFrame(this.pollPad);
  }

  // 프레임마다 패드를 읽는다. 메인 루프보다 먼저 등록되므로 같은 프레임의 틱이 최신 입력을 쓴다.
  private pollPad = (t: number): void => {
    requestAnimationFrame(this.pollPad);
    // 탭이 숨겨졌다 돌아오는 등 폴링이 끊겼으면 그 사이 바뀐 버튼은 입력으로 세지 않는다
    if (t - this.padLastT > 250) this.pad.resync();
    this.padLastT = t;
    let pads: ArrayLike<Gamepad | null> | null = null;
    try {
      pads = navigator.getGamepads();
    } catch {
      /* 권한 정책으로 막힌 환경: 패드 없음으로 취급 */
    }
    this.pad.poll(pads);
  };

  get mx(): number {
    const d = this.down;
    return (d.has('KeyD') || d.has('ArrowRight') ? 1 : 0) - (d.has('KeyA') || d.has('ArrowLeft') ? 1 : 0) || this.pad.mx || this.touchMx;
  }

  get my(): number {
    const d = this.down;
    return (d.has('KeyS') || d.has('ArrowDown') ? 1 : 0) - (d.has('KeyW') || d.has('ArrowUp') ? 1 : 0) || this.pad.my || this.touchMy;
  }

  reset(): void {
    this.dashQueued = false;
    this.choiceQueued = -1;
  }
}
