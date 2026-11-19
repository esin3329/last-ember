import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { Store } from '../src/store.ts';

interface IssueBody {
  runId?: string;
  error?: string;
}

async function withApp(trustProxyHops: number | undefined, run: (base: string, store: Store) => Promise<void>): Promise<void> {
  const store = new Store(':memory:');
  const server = createApp({
    store,
    verify: async () => {
      throw new Error('이 테스트에서는 검증을 호출하지 않는다');
    },
    now: () => 0,
    ...(trustProxyHops === undefined ? {} : { trustProxyHops }),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base, store);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    store.close();
  }
}

async function issue(base: string, forwardedFor: string): Promise<{ status: number; body: IssueBody }> {
  const response = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': forwardedFor },
  });
  return { status: response.status, body: (await response.json()) as IssueBody };
}

test('기본 설정에서는 위조 X-Forwarded-For를 무시한다', async () => {
  await withApp(undefined, async (base) => {
    for (let i = 1; i <= 20; i++) {
      assert.equal((await issue(base, `198.51.100.${i}`)).status, 201);
    }
    assert.equal((await issue(base, '203.0.113.1')).status, 429);
  });
});

test('신뢰 프록시 1홉은 오른쪽 XFF 주소로 제한과 발급 상한을 적용한다', async () => {
  await withApp(1, async (base, store) => {
    const first = await issue(base, '203.0.113.1, 198.51.100.10');
    assert.equal(first.status, 201);
    assert.ok(first.body.runId);

    for (let i = 2; i <= 4; i++) {
      assert.equal((await issue(base, `203.0.113.${i}, 198.51.100.10`)).status, 201);
    }
    assert.equal(store.getRun(first.body.runId)?.status, 'rejected');
    assert.equal(store.getRun(first.body.runId)?.reject_reason, 'abandoned');

    for (let i = 5; i <= 20; i++) {
      assert.equal((await issue(base, `203.0.113.${i}, 198.51.100.10`)).status, 201);
    }
    assert.equal((await issue(base, '203.0.113.21, 198.51.100.10')).status, 429);
    assert.equal((await issue(base, '203.0.113.22, 198.51.100.11')).status, 201);
  });
});

test('신뢰 프록시 2홉은 오른쪽에서 두 번째 XFF 주소를 선택한다', async () => {
  await withApp(2, async (base) => {
    for (let i = 1; i <= 20; i++) {
      assert.equal((await issue(base, `203.0.113.${i}, 198.51.100.20, 192.0.2.${i}`)).status, 201);
    }
    assert.equal((await issue(base, '203.0.113.21, 198.51.100.20, 192.0.2.21')).status, 429);
    assert.equal((await issue(base, '203.0.113.21, 198.51.100.21, 192.0.2.21')).status, 201);
  });
});
