// 프록시 신뢰 경계 단위 테스트: 신뢰 대역 밖에서 온 XFF는 어떤 형태로든 클라이언트 주소가 되지 못한다.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type TrustProxyConfig,
  isTrustedPeer,
  normalizeIp,
  parseTrustProxyCidrs,
  parseTrustProxyConfig,
  resolveClientIp,
} from '../src/trustedProxy.ts';

function config(hops: number, cidrs: string): TrustProxyConfig {
  return { hops, cidrs: parseTrustProxyCidrs(cidrs) };
}

test('CIDR 파싱: 올바른 IPv4/IPv6 목록을 받는다', () => {
  const list = parseTrustProxyCidrs('10.0.0.0/8, 192.168.1.5/32 ,2001:db8::/32,::1/128');
  assert.deepEqual(list.map((c) => [c.family, c.prefix]), [[4, 8], [4, 32], [6, 32], [6, 128]]);
});

test('CIDR 파싱: 모호하거나 지나치게 넓은 항목은 시작 시점에 거절한다', () => {
  const bad = [
    '',
    '10.0.0.0/8,',
    ',10.0.0.0/8',
    '10.0.0.1',
    '10.0.0.0/',
    '10.0.0.0/08',
    '10.0.0.0/33',
    '10.0.0.1/8', // 호스트 비트
    '10.0.0.0/8/8',
    '0.0.0.0/0',
    '::/0',
    '2001:db8::/129',
    '2001:db8::1/32', // 호스트 비트
    '256.0.0.0/8',
    '10.0.0/8',
    '010.0.0.0/8',
    'proxy.example/24',
    'fe80::/10%eth0',
    'fe80::%eth0/10',
    '::ffff:10.0.0.0/104',
    '10.0.0.0/-1',
    '10.0.0.0/8 extra',
  ];
  for (const value of bad) {
    assert.throws(() => parseTrustProxyCidrs(value), /TRUST_PROXY_CIDRS/, JSON.stringify(value));
  }
  const tooMany = Array.from({ length: 65 }, (_, i) => `10.0.${i}.0/24`).join(',');
  assert.throws(() => parseTrustProxyCidrs(tooMany), /최대 64/);
});

test('설정 조합: 홉 수와 CIDR 중 하나만 있으면 실패한다', () => {
  assert.deepEqual(parseTrustProxyConfig({}), { hops: 0, cidrs: [] });
  assert.deepEqual(parseTrustProxyConfig({ TRUST_PROXY: '0', TRUST_PROXY_CIDRS: '' }), { hops: 0, cidrs: [] });
  assert.throws(() => parseTrustProxyConfig({ TRUST_PROXY: '1' }), /requires TRUST_PROXY_CIDRS/);
  assert.throws(() => parseTrustProxyConfig({ TRUST_PROXY: '1', TRUST_PROXY_CIDRS: '  ' }), /requires TRUST_PROXY_CIDRS/);
  assert.throws(() => parseTrustProxyConfig({ TRUST_PROXY_CIDRS: '10.0.0.0/8' }), /requires TRUST_PROXY >= 1/);
  assert.throws(() => parseTrustProxyConfig({ TRUST_PROXY: '0', TRUST_PROXY_CIDRS: '10.0.0.0/8' }), /requires TRUST_PROXY >= 1/);
  const ok = parseTrustProxyConfig({ TRUST_PROXY: '2', TRUST_PROXY_CIDRS: '10.0.0.0/8' });
  assert.equal(ok.hops, 2);
  assert.equal(ok.cidrs.length, 1);
});

test('TRUST_PROXY 값 검증: 정수 0..32만 허용한다', () => {
  for (const value of ['-1', '33', '1.5', 'abc', '1e1', '0x1', '+1', '100']) {
    assert.throws(() => parseTrustProxyConfig({ TRUST_PROXY: value, TRUST_PROXY_CIDRS: '10.0.0.0/8' }), /TRUST_PROXY must be/, value);
  }
  assert.equal(parseTrustProxyConfig({ TRUST_PROXY: '32', TRUST_PROXY_CIDRS: '10.0.0.0/8' }).hops, 32);
});

test('신뢰 대역 밖의 소켓 피어가 보낸 XFF는 무시한다', () => {
  const c = config(1, '10.0.0.0/8');
  assert.equal(resolveClientIp('203.0.113.9', '198.51.100.7', c), '203.0.113.9');
  assert.equal(resolveClientIp('11.0.0.1', '198.51.100.7', c), '11.0.0.1');
  assert.equal(resolveClientIp('2001:db8::1', '198.51.100.7', c), '2001:db8::1');
  assert.equal(resolveClientIp(undefined, '198.51.100.7', c), 'unknown');
});

test('신뢰 피어: 홉 1이면 XFF 마지막 항목이 클라이언트다(위조된 왼쪽 항목은 무시)', () => {
  const c = config(1, '10.0.0.0/8');
  assert.equal(resolveClientIp('10.1.2.3', '198.51.100.7', c), '198.51.100.7');
  assert.equal(resolveClientIp('10.1.2.3', '6.6.6.6, 198.51.100.7', c), '198.51.100.7');
  assert.equal(resolveClientIp('10.1.2.3', ['6.6.6.6', '198.51.100.7'], c), '198.51.100.7');
});

test('정확한 홉 수: N개의 프록시가 모두 신뢰 대역일 때만 오른쪽 N번째 항목을 쓴다', () => {
  const c = config(2, '10.0.0.0/8');
  // 체인: client, proxy1(10.0.0.2) → 소켓 피어 proxy2(10.0.0.3)
  assert.equal(resolveClientIp('10.0.0.3', '198.51.100.7, 10.0.0.2', c), '198.51.100.7');
  // 왼쪽에 끼워 넣은 값은 읽지 않는다
  assert.equal(resolveClientIp('10.0.0.3', '6.6.6.6, 198.51.100.7, 10.0.0.2', c), '198.51.100.7');
  // 중간 프록시가 신뢰 대역이 아니면 XFF 전체를 무시
  assert.equal(resolveClientIp('10.0.0.3', '198.51.100.7, 203.0.113.50', c), '10.0.0.3');
  // 홉 수보다 짧은 체인
  assert.equal(resolveClientIp('10.0.0.3', '198.51.100.7', c), '10.0.0.3');
  // 중간 프록시 항목이 IP가 아님
  assert.equal(resolveClientIp('10.0.0.3', '198.51.100.7, unknown', c), '10.0.0.3');
});

test('형식이 틀린 XFF는 소켓 피어로 되돌린다', () => {
  const c = config(1, '10.0.0.0/8');
  for (const header of ['', 'not-an-ip', '198.51.100.7:443', '198.51.100.7, ', '999.1.1.1', undefined]) {
    assert.equal(resolveClientIp('10.1.2.3', header, c), '10.1.2.3', String(header));
  }
});

test('프록시 설정이 없으면 XFF를 읽지 않는다', () => {
  const none = { hops: 0, cidrs: [] };
  assert.equal(resolveClientIp('10.1.2.3', '198.51.100.7', none), '10.1.2.3');
  assert.equal(isTrustedPeer('10.1.2.3', none), false);
  // 홉 수가 0이면 CIDR이 있어도 신뢰하지 않는다
  assert.equal(isTrustedPeer('10.1.2.3', { hops: 0, cidrs: parseTrustProxyCidrs('10.0.0.0/8') }), false);
});

test('IPv4-매핑 IPv6 피어는 IPv4 CIDR로 판정하고 IPv4로 정규화한다', () => {
  const c = config(1, '10.0.0.0/8');
  assert.equal(resolveClientIp('::ffff:10.1.2.3', '198.51.100.7', c), '198.51.100.7');
  assert.equal(resolveClientIp('::ffff:203.0.113.9', '198.51.100.7', c), '203.0.113.9');
  assert.equal(normalizeIp('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(resolveClientIp('10.1.2.3', '::ffff:198.51.100.7', c), '198.51.100.7');
});

test('IPv6 대역 경계와 정규화', () => {
  const c = config(1, '2001:db8:abcd::/48');
  assert.equal(resolveClientIp('2001:db8:abcd:ffff::1', '198.51.100.7', c), '198.51.100.7');
  assert.equal(resolveClientIp('2001:db8:abce::1', '198.51.100.7', c), '2001:db8:abce::1');
  assert.equal(resolveClientIp('2001:0db8:abcd:0000:0000:0000:0000:0001', '2001:DB8:1:0:0:0:0:5', c), '2001:db8:1::5');
  assert.equal(resolveClientIp('2001:db8:abcd::1%eth0', '198.51.100.7', c), '198.51.100.7');
});

test('IPv4 비트 단위 경계', () => {
  const c = config(1, '192.168.1.128/25,172.16.0.0/12');
  assert.equal(isTrustedPeer('192.168.1.128', c), true);
  assert.equal(isTrustedPeer('192.168.1.255', c), true);
  assert.equal(isTrustedPeer('192.168.1.127', c), false);
  assert.equal(isTrustedPeer('172.31.255.255', c), true);
  assert.equal(isTrustedPeer('172.32.0.0', c), false);
  // 주소 계열이 다르면 일치하지 않는다
  assert.equal(isTrustedPeer('::ffff:0:0', config(1, '2001:db8::/32')), false);
});

test('단일 호스트 /32, /128', () => {
  const c = config(1, '192.0.2.10/32,2001:db8::10/128');
  assert.equal(isTrustedPeer('192.0.2.10', c), true);
  assert.equal(isTrustedPeer('192.0.2.11', c), false);
  assert.equal(isTrustedPeer('2001:db8::10', c), true);
  assert.equal(isTrustedPeer('2001:db8::11', c), false);
});
