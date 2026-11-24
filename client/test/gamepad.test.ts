import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type GamepadHandlers, GamepadInput, type PadLike, STICK_ENGAGE } from '../src/gamepad.ts';
import { type InputFrame, decodeFrame, encodeFrame, isValidCode } from '../../shared/input.ts';

const A = 0, B = 1, X = 2, Y = 3, RB = 5, RT = 7, START = 9, UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15;

function makePad(over: { axes?: number[]; down?: number[]; mapping?: string; id?: string; connected?: boolean } = {}): PadLike {
  const down = new Set(over.down ?? []);
  return {
    connected: over.connected ?? true,
    mapping: over.mapping ?? 'standard',
    id: over.id ?? 'test-pad',
    axes: over.axes ?? [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: down.has(i), value: down.has(i) ? 1 : 0 })),
  };
}

function setup() {
  const log: string[] = [];
  const h: GamepadHandlers = {
    dash: () => log.push('dash'),
    choice: (i) => log.push(`choice${i}`),
    pause: () => log.push('pause'),
    disconnect: () => log.push('disconnect'),
  };
  const gp = new GamepadInput(h);
  // 첫 poll은 기준선만 잡으므로 빈 패드로 연결해 둔다
  gp.poll([makePad()]);
  return { gp, log };
}

const stick = (deg: number, mag = 1) => makePad({ axes: [Math.cos((deg * Math.PI) / 180) * mag, Math.sin((deg * Math.PI) / 180) * mag, 0, 0] });

test('스틱은 8방향으로 양자화되고 y는 아래가 양수다', () => {
  const { gp } = setup();
  const expected: [number, number, number][] = [
    [0, 1, 0], [45, 1, 1], [90, 0, 1], [135, -1, 1], [180, -1, 0], [225, -1, -1], [270, 0, -1], [315, 1, -1],
  ];
  for (const [deg, mx, my] of expected) {
    for (const off of [-20, 0, 20]) {
      const g = setup().gp;
      g.poll([stick(deg + off)]);
      assert.deepEqual([g.mx, g.my], [mx, my], `${deg + off}°`);
    }
  }
  assert.equal(gp.mx, 0);
});

test('데드존: 작은 입력은 무시하고 히스테리시스로 경계에서 깜박이지 않는다', () => {
  const { gp } = setup();
  gp.poll([stick(0, STICK_ENGAGE - 0.01)]);
  assert.deepEqual([gp.mx, gp.my], [0, 0]);
  gp.poll([stick(0, STICK_ENGAGE + 0.01)]);
  assert.deepEqual([gp.mx, gp.my], [1, 0]);
  gp.poll([stick(0, 0.3)]); // 이미 눌린 뒤에는 0.25까지 유지
  assert.deepEqual([gp.mx, gp.my], [1, 0]);
  gp.poll([stick(0, 0.2)]);
  assert.deepEqual([gp.mx, gp.my], [0, 0]);
  gp.poll([stick(0, 0.3)]); // 놓은 뒤에는 다시 0.35를 넘어야 한다
  assert.deepEqual([gp.mx, gp.my], [0, 0]);
});

test('섹터 경계 근처에서는 이전 방향을 유지한다', () => {
  const { gp } = setup();
  gp.poll([stick(10)]);
  assert.deepEqual([gp.mx, gp.my], [1, 0]);
  gp.poll([stick(25)]); // 22.5° 경계를 넘었지만 히스테리시스 안
  assert.deepEqual([gp.mx, gp.my], [1, 0]);
  gp.poll([stick(35)]);
  assert.deepEqual([gp.mx, gp.my], [1, 1]);
});

test('NaN/비정상 축 값은 0으로 취급한다', () => {
  const { gp } = setup();
  gp.poll([makePad({ axes: [NaN, Infinity] })]);
  assert.deepEqual([gp.mx, gp.my], [0, 0]);
});

test('D-pad는 스틱보다 우선하고 반대 방향은 상쇄한다', () => {
  const { gp } = setup();
  gp.poll([makePad({ down: [LEFT, UP] })]);
  assert.deepEqual([gp.mx, gp.my], [-1, -1]);
  gp.poll([makePad({ down: [LEFT, RIGHT, DOWN], axes: [1, 0] })]);
  assert.deepEqual([gp.mx, gp.my], [0, 1]);
  gp.poll([makePad({ axes: [1, 0] })]);
  assert.deepEqual([gp.mx, gp.my], [1, 0]);
});

test('대시는 누른 순간 한 번만, 같은 패드의 여러 대시 버튼도 한 번', () => {
  const { gp, log } = setup();
  for (let i = 0; i < 30; i++) gp.poll([makePad({ down: [A] })]);
  assert.deepEqual(log, ['dash']);
  gp.poll([makePad()]);
  gp.poll([makePad({ down: [RT] })]);
  gp.poll([makePad({ down: [RT, RB, A] })]); // 이미 눌린 상태에서 추가 버튼은 새 입력이 아님
  assert.deepEqual(log, ['dash', 'dash']);
});

test('레벨업 선택: X/Y/B → 0/1/2, 누르고 있어도 반복되지 않는다', () => {
  const { gp, log } = setup();
  for (const [btn, idx] of [[X, 0], [Y, 1], [B, 2]]) {
    for (let i = 0; i < 5; i++) gp.poll([makePad({ down: [btn] })]);
    gp.poll([makePad()]);
    assert.equal(log.at(-1), `choice${idx}`);
  }
  assert.deepEqual(log, ['choice0', 'choice1', 'choice2']);
});

test('일시정지(Start)는 edge마다 한 번', () => {
  const { gp, log } = setup();
  for (let i = 0; i < 10; i++) gp.poll([makePad({ down: [START] })]);
  gp.poll([makePad()]);
  gp.poll([makePad({ down: [START] })]);
  assert.deepEqual(log, ['pause', 'pause']);
});

test('처음 연결된 패드에서 이미 눌려 있던 버튼과 resync 직후 바뀐 버튼은 edge가 아니다', () => {
  const log: string[] = [];
  const gp = new GamepadInput({ dash: () => log.push('dash'), choice: () => log.push('choice'), pause: () => log.push('pause'), disconnect: () => log.push('disconnect') });
  gp.poll([makePad({ down: [A, START] })]);
  assert.deepEqual(log, []);
  gp.poll([makePad()]);
  gp.resync();
  gp.poll([makePad({ down: [A, X] })]); // 폴링이 끊긴 사이 눌린 것
  assert.deepEqual(log, []);
  gp.poll([makePad()]);
  gp.poll([makePad({ down: [A] })]);
  assert.deepEqual(log, ['dash']);
});

test('연결 해제: 축을 0으로 돌리고 한 번만 알린다', () => {
  const { gp, log } = setup();
  gp.poll([stick(0)]);
  assert.equal(gp.mx, 1);
  gp.poll([null]);
  assert.deepEqual([gp.mx, gp.my], [0, 0]);
  assert.deepEqual(log, ['disconnect']);
  for (let i = 0; i < 5; i++) gp.poll([null]);
  gp.poll([makePad({ connected: false })]);
  gp.poll(null);
  assert.deepEqual(log, ['disconnect']);
});

test('같은 슬롯에 다른 장치가 꽂히면 해제로 보고 새 장치는 기준선부터 시작한다', () => {
  const { gp, log } = setup();
  gp.poll([makePad({ id: 'other', down: [A] })]);
  assert.deepEqual(log, ['disconnect']); // 새 패드의 A는 dash가 아님
  gp.poll([makePad({ id: 'other' })]);
  gp.poll([makePad({ id: 'other', down: [A] })]);
  assert.deepEqual(log, ['disconnect', 'dash']);
});

test('재연결 후 다시 동작하고, 해제 이후 두 번째 패드로 넘어간다', () => {
  const { gp, log } = setup();
  gp.poll([null, makePad({ id: 'second', axes: [0, 1] })]); // 슬롯 0 해제, 슬롯 1 채택
  assert.deepEqual(log, ['disconnect']);
  assert.deepEqual([gp.mx, gp.my], [0, 1]);
  gp.poll([makePad({ id: 'second2' }), makePad({ id: 'second', down: [A] })]); // 활성(슬롯1)만 본다
  assert.deepEqual(log, ['disconnect', 'dash']);
});

test('standard 매핑이 아닌 장치는 무시한다', () => {
  const { gp, log } = setup();
  gp.poll([null]);
  log.length = 0;
  gp.poll([makePad({ mapping: '', axes: [1, 0], down: [A] })]);
  assert.equal(gp.connected, false);
  assert.deepEqual([gp.mx, gp.my, log.length], [0, 0, 0]);
});

test('게임패드가 만드는 모든 입력은 기존 프레임 인코딩에서 그대로 왕복된다', () => {
  const out: InputFrame = { mx: 0, my: 0, dash: false, choice: -1 };
  const { gp } = setup();
  for (let deg = 0; deg < 360; deg += 3) {
    for (const mag of [0, 0.3, 0.6, 1]) {
      gp.poll([stick(deg, mag)]);
      const f: InputFrame = { mx: gp.mx, my: gp.my, dash: false, choice: -1 };
      assert.ok(Number.isInteger(f.mx) && Number.isInteger(f.my) && Math.abs(f.mx) <= 1 && Math.abs(f.my) <= 1);
      const code = encodeFrame(f);
      assert.ok(isValidCode(code));
      assert.deepEqual(decodeFrame(code, out), f);
    }
  }
});
