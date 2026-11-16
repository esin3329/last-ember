// 터치 조작: 화면을 누른 지점이 중심이 되는 가상 조이스틱 + 대시/일시정지 버튼.
// 시뮬레이션 입력은 8방향이므로 조이스틱 각도를 8방향으로 양자화해서 키보드와 같은 값을 만든다.

import type { Keyboard } from './keyboard.ts';

const DEAD_ZONE = 12;
const MAX_REACH = 46;

export function setupTouch(canvas: HTMLCanvasElement, kb: Keyboard, onPause: () => void): void {
  const stick = document.getElementById('stick')!;
  const knob = document.getElementById('knob')!;
  const dashBtn = document.getElementById('dashbtn')!;
  const pauseBtn = document.getElementById('pausebtn')!;
  let pointerId = -1;
  let ox = 0;
  let oy = 0;

  function release(): void {
    pointerId = -1;
    kb.touchMx = 0;
    kb.touchMy = 0;
    stick.classList.add('hidden');
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || pointerId !== -1) return;
    // 터치 입력을 한 번이라도 받으면 터치용 버튼을 보여 준다
    document.body.classList.add('touch');
    pointerId = e.pointerId;
    ox = e.clientX;
    oy = e.clientY;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 캡처를 못 해도 조이스틱은 동작한다 */
    }
    stick.style.left = `${ox}px`;
    stick.style.top = `${oy}px`;
    knob.style.transform = 'translate(-50%, -50%)';
    stick.classList.remove('hidden');
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    const dx = e.clientX - ox;
    const dy = e.clientY - oy;
    const len = Math.hypot(dx, dy);
    if (len < DEAD_ZONE) {
      kb.touchMx = 0;
      kb.touchMy = 0;
    } else {
      // 축 성분이 전체 길이의 38%를 넘으면 그 축을 켠다 → 45도 간격의 8방향
      kb.touchMx = Math.abs(dx) > len * 0.38 ? Math.sign(dx) : 0;
      kb.touchMy = Math.abs(dy) > len * 0.38 ? Math.sign(dy) : 0;
    }
    const k = len > MAX_REACH ? MAX_REACH / len : 1;
    knob.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
  });

  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    canvas.addEventListener(type, (e) => {
      if (e.pointerId === pointerId) release();
    });
  }

  dashBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    kb.dashQueued = true;
  });
  pauseBtn.addEventListener('click', onPause);
}
