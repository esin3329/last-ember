import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { parseVerifierWorkerCount } from '../src/verifier.ts';
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

test('VERIFY_WORKERS는 정수 1~32만 허용한다', () => {
  const message = /VERIFY_WORKERS must be an integer between 1 and 32/;
  for (const value of ['0', '', 'foo', '1.5', '1e2', '33']) {
    assert.throws(() => parseVerifierWorkerCount(value, 4), message, value);
  }
  assert.equal(parseVerifierWorkerCount('1', 4), 1);
  assert.equal(parseVerifierWorkerCount('32', 4), 32);
  assert.equal(parseVerifierWorkerCount(undefined, 4), 4);
});

test('잘못된 VERIFY_WORKERS는 DB를 열거나 서버를 시작하기 전에 실패한다', () => {
  for (const value of ['0', '', 'foo', '1.5', '1e2', '33']) {
    const result = spawnSync(process.execPath, ['server/src/main.ts'], {
      env: { ...process.env, VERIFY_WORKERS: value, TRUST_PROXY: '0', DB_PATH: ':memory:', PORT: '0' },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 1, `${value}: ${result.error}`);
    assert.match(result.stderr, /VERIFY_WORKERS must be an integer between 1 and 32/);
    assert.doesNotMatch(result.stdout, /LAST EMBER 서버/);
  }
});

test('잘못된 TRUST_PROXY는 DB를 열거나 서버를 시작하기 전에 실패한다', () => {
  for (const value of ['no', '-1', '1.5', 'Infinity', '33', '9007199254740992']) {
    const result = spawnSync(process.execPath, ['server/src/main.ts'], {
      env: { ...process.env, TRUST_PROXY: value, DB_PATH: ':memory:', PORT: '0' },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 1, `${value}: ${result.error}`);
    assert.match(result.stderr, /TRUST_PROXY must be an integer between 0 and 32/);
    assert.doesNotMatch(result.stdout, /LAST EMBER 서버/);
  }
});

test('동일 IPv6 표기와 IPv4 매핑 표기는 같은 발급 상한과 속도 제한을 공유한다', async () => {
  for (const forms of [
    ['2001:db8::abcd', '2001:0DB8:0:0:0:0:0:ABCD'],
    ['192.0.2.1', '::ffff:c000:201', '::ffff:192.0.2.1'],
    ['fe80::1%eth0', 'fe80:0:0:0:0:0:0:1%eth1'],
  ]) {
    await withApp(1, async (base, store) => {
      const first = await issue(base, forms[0]);
      for (let i = 1; i < 20; i++) {
        assert.equal((await issue(base, forms[i % forms.length])).status, 201);
      }
      assert.equal(store.getRun(first.body.runId!)?.reject_reason, 'abandoned');
      assert.equal((await issue(base, forms[0])).status, 429);
    });
  }
});

test('중복 XFF 헤더와 공백은 전송 순서의 오른쪽 주소를 사용한다', async () => {
  await withApp(1, async (base) => {
    for (let i = 0; i < 20; i++) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(`${base}/api/runs`, {
          method: 'POST',
          headers: ['Host', new URL(base).host, 'X-Forwarded-For', `203.0.113.${i}`, 'X-Forwarded-For', ' 198.51.100.10 '],
        }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode!));
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 201);
    }
    assert.equal((await issue(base, '198.51.100.10')).status, 429);
  });
});

test('부족한 홉과 포트 또는 대괄호가 붙은 주소는 소켓 IP로 제한한다', async () => {
  await withApp(2, async (base) => {
    const headers = ['198.51.100.1', '198.51.100.1:123, 192.0.2.1', '[2001:db8::1], 192.0.2.1', ', 192.0.2.1'];
    for (let i = 0; i < 20; i++) {
      assert.equal((await issue(base, headers[i % headers.length])).status, 201);
    }
    assert.equal((await issue(base, headers[0])).status, 429);
  });
});
