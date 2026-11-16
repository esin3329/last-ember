// 키보드 입력. 눌린 키 집합에서 이동 축을 읽고, 대시/선택은 "눌린 순간"만 큐에 넣는다.

const BLOCK_SCROLL = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

export class Keyboard {
  private down = new Set<string>();
  dashQueued = false;
  choiceQueued = -1;
  // 터치 조이스틱이 채우는 축 값 (touch.ts)
  touchMx = 0;
  touchMy = 0;
  onPress: (code: string) => void = () => {};

  constructor() {
    window.addEventListener('keydown', (e) => {
      // 이름 입력 중에는 게임 키로 처리하지 않는다
      if (e.target instanceof HTMLInputElement) return;
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
    window.addEventListener('blur', () => this.down.clear());
  }

  get mx(): number {
    const d = this.down;
    return (d.has('KeyD') || d.has('ArrowRight') ? 1 : 0) - (d.has('KeyA') || d.has('ArrowLeft') ? 1 : 0) || this.touchMx;
  }

  get my(): number {
    const d = this.down;
    return (d.has('KeyS') || d.has('ArrowDown') ? 1 : 0) - (d.has('KeyW') || d.has('ArrowUp') ? 1 : 0) || this.touchMy;
  }

  reset(): void {
    this.dashQueued = false;
    this.choiceQueued = -1;
  }
}
