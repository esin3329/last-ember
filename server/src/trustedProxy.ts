// 프록시 신뢰 경계.
//
// X-Forwarded-For(XFF)는 누구나 보낼 수 있는 헤더다. 이 모듈은 "연결을 맺은 소켓 피어가 운영자가
// 명시한 프록시 대역(TRUST_PROXY_CIDRS)에 속할 때만" XFF를 읽는다.
//
//   TRUST_PROXY        신뢰하는 프록시 홉 수 N (0..32, 기본 0). 소켓 피어가 1번째 홉이다.
//   TRUST_PROXY_CIDRS  쉼표로 구분한 IPv4/IPv6 CIDR 목록. 프록시 홉으로 인정할 주소 대역.
//
// 홉 수 의미는 기존과 같다: 체인 = XFF 항목들 + 소켓 피어, 클라이언트 = XFF의 오른쪽 N번째 항목.
// 거기에 더해 N개의 프록시 홉(소켓 피어와 XFF 오른쪽 N-1개 항목) 전부가 CIDR 목록에 속해야 한다.
// 하나라도 벗어나면 XFF 전체를 무시하고 소켓 피어 주소를 쓴다. 클라이언트가 왼쪽에 끼워 넣은
// 항목은 어떤 경우에도 읽히지 않는다.

import { isIP } from 'node:net';

export const MAX_TRUST_PROXY_HOPS = 32;
export const MAX_TRUST_PROXY_CIDRS = 64;

export interface Cidr {
  family: 4 | 6;
  /** 네트워크 주소 바이트(IPv4 4개, IPv6 16개). 호스트 비트는 0이다. */
  bytes: Uint8Array;
  prefix: number;
  /** 로그·오류 메시지용 입력 표기. */
  text: string;
}

export interface TrustProxyConfig {
  hops: number;
  cidrs: readonly Cidr[];
}

/** 신뢰하지 않는 기본 설정: XFF를 읽지 않는다. */
export const NO_TRUSTED_PROXY: TrustProxyConfig = { hops: 0, cidrs: [] };

interface ParsedIp {
  family: 4 | 6;
  bytes: Uint8Array;
}

/** 주소를 바이트로 바꾼다. IPv4-매핑 IPv6(::ffff:a.b.c.d)는 IPv4로 접는다. IP가 아니면 null. */
function parseIp(address: string): ParsedIp | null {
  const family = isIP(address);
  if (family === 4) return { family: 4, bytes: Uint8Array.from(address.split('.').map(Number)) };
  if (family !== 6) return null;

  // 존 ID(fe80::1%eth0)는 주소 식별에 쓰지 않는다. URL 파서로 압축·임베디드 IPv4를 정규화한다.
  const canonical = new URL(`http://[${address.split('%')[0]}]/`).hostname.slice(1, -1);
  const [head, tail] = canonical.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail === undefined ? [] : tail ? tail.split(':') : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = tail === undefined ? headGroups : [...headGroups, ...Array<string>(missing).fill('0'), ...tailGroups];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  groups.forEach((group, i) => {
    const value = parseInt(group, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 255;
  });

  const mapped = bytes.subarray(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255;
  return mapped ? { family: 4, bytes: bytes.slice(12) } : { family: 6, bytes };
}

/** 로그 키·레이트 리밋 키로 쓰는 표준 표기. IPv4-매핑 IPv6는 IPv4로 접고, 그 외 IPv6는 압축형이다. */
export function normalizeIp(address: string): string {
  if (isIP(address) !== 6) return address;
  const parsed = parseIp(address);
  if (parsed?.family === 4) return Array.from(parsed.bytes).join('.');
  return new URL(`http://[${address.split('%')[0]}]/`).hostname.slice(1, -1);
}

function hasHostBits(bytes: Uint8Array, prefix: number): boolean {
  for (let bit = prefix; bit < bytes.length * 8; bit++) {
    if (bytes[bit >> 3] & (0x80 >> (bit & 7))) return true;
  }
  return false;
}

function parseCidr(entry: string): Cidr {
  const parts = entry.split('/');
  if (parts.length !== 2) throw new Error(`TRUST_PROXY_CIDRS: "${entry}" 은(는) <주소>/<접두 길이> 형식이어야 합니다`);
  const [address, prefixText] = parts;
  if (!/^(0|[1-9]\d{0,2})$/.test(prefixText)) {
    throw new Error(`TRUST_PROXY_CIDRS: "${entry}" 의 접두 길이는 앞자리 0 없는 십진수여야 합니다`);
  }
  if (address.includes('%')) throw new Error(`TRUST_PROXY_CIDRS: "${entry}" 에 존 ID는 쓸 수 없습니다`);
  if (/^::ffff:/i.test(address)) {
    throw new Error(`TRUST_PROXY_CIDRS: "${entry}" IPv4-매핑 IPv6 대신 IPv4 CIDR을 쓰십시오`);
  }
  const ip = parseIp(address);
  if (!ip) throw new Error(`TRUST_PROXY_CIDRS: "${entry}" 의 주소가 올바른 IPv4/IPv6가 아닙니다`);

  const prefix = Number(prefixText);
  if (prefix > ip.bytes.length * 8) throw new Error(`TRUST_PROXY_CIDRS: "${entry}" 의 접두 길이가 범위를 벗어났습니다`);
  if (prefix === 0) throw new Error(`TRUST_PROXY_CIDRS: "${entry}" 은(는) 모든 주소를 신뢰하므로 허용하지 않습니다`);
  if (hasHostBits(ip.bytes, prefix)) {
    throw new Error(`TRUST_PROXY_CIDRS: "${entry}" 의 호스트 비트가 0이 아닙니다(네트워크 주소를 쓰십시오)`);
  }
  return { family: ip.family, bytes: ip.bytes, prefix, text: entry };
}

/** 쉼표로 구분한 CIDR 목록을 엄격하게 파싱한다. 빈 항목·중복 형식 오류는 모두 거절한다. */
export function parseTrustProxyCidrs(value: string): Cidr[] {
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length > MAX_TRUST_PROXY_CIDRS) {
    throw new Error(`TRUST_PROXY_CIDRS: 항목은 최대 ${MAX_TRUST_PROXY_CIDRS}개입니다`);
  }
  return entries.map((entry) => {
    if (entry === '') throw new Error('TRUST_PROXY_CIDRS: 빈 항목이 있습니다');
    return parseCidr(entry);
  });
}

function parseHops(value: string | undefined): number {
  const text = value?.trim() ?? '';
  if (text === '') return 0;
  const hops = /^\d{1,2}$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(hops) || hops > MAX_TRUST_PROXY_HOPS) {
    throw new Error(`TRUST_PROXY must be an integer between 0 and ${MAX_TRUST_PROXY_HOPS}`);
  }
  return hops;
}

/**
 * 환경 변수에서 신뢰 설정을 만든다. 잘못된 조합은 서버 시작 전에 실패시킨다.
 *  - TRUST_PROXY=0 또는 미설정, CIDR 미설정  → 프록시 없음
 *  - TRUST_PROXY>0 이고 CIDR 미설정          → 오류(어느 피어를 신뢰할지 모르면 XFF를 읽지 않는다)
 *  - TRUST_PROXY=0 이고 CIDR 설정            → 오류(홉 수가 없으면 의미가 모호하다)
 * TRUST_PROXY_CIDRS가 빈 문자열이면 미설정으로 본다.
 */
export function parseTrustProxyConfig(env: {
  TRUST_PROXY?: string | undefined;
  TRUST_PROXY_CIDRS?: string | undefined;
}): TrustProxyConfig {
  const hops = parseHops(env.TRUST_PROXY);
  const raw = env.TRUST_PROXY_CIDRS?.trim() ?? '';
  const cidrs = raw === '' ? [] : parseTrustProxyCidrs(raw);

  if (hops > 0 && cidrs.length === 0) {
    throw new Error('TRUST_PROXY > 0 requires TRUST_PROXY_CIDRS (comma-separated proxy CIDRs)');
  }
  if (hops === 0 && cidrs.length > 0) {
    throw new Error('TRUST_PROXY_CIDRS requires TRUST_PROXY >= 1 (number of trusted proxy hops)');
  }
  return { hops, cidrs };
}

function inCidr(ip: ParsedIp, cidr: Cidr): boolean {
  if (ip.family !== cidr.family) return false;
  const whole = cidr.prefix >> 3;
  for (let i = 0; i < whole; i++) if (ip.bytes[i] !== cidr.bytes[i]) return false;
  const rest = cidr.prefix & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (ip.bytes[whole] & mask) === cidr.bytes[whole];
}

function isTrustedAddress(address: string, config: TrustProxyConfig): boolean {
  const ip = parseIp(address);
  return ip !== null && config.cidrs.some((cidr) => inCidr(ip, cidr));
}

/** 소켓 피어가 신뢰 프록시일 때만 true. X-Forwarded-Proto 같은 다른 전달 헤더를 읽을지 판단할 때 쓴다. */
export function isTrustedPeer(remoteAddress: string | undefined, config: TrustProxyConfig): boolean {
  return config.hops > 0 && remoteAddress !== undefined && isTrustedAddress(remoteAddress, config);
}

/**
 * 요청의 클라이언트 주소를 정한다. 신뢰 조건이 하나라도 어긋나면 소켓 피어 주소를 돌려준다.
 * XFF 헤더 값은 Node가 중복 헤더를 ", "로 합친 문자열이거나(드물게) 배열이다.
 */
export function resolveClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  config: TrustProxyConfig,
): string {
  const peer = normalizeIp(remoteAddress ?? 'unknown');
  if (!isTrustedPeer(remoteAddress, config)) return peer;

  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  if (typeof header !== 'string') return peer;

  const chain = header.split(',').map((address) => address.trim());
  const clientIndex = chain.length - config.hops;
  if (clientIndex < 0) return peer;

  // 체인의 오른쪽 N-1개 항목은 소켓 피어 뒤의 프록시들이다. 전부 신뢰 대역이어야 한다.
  for (let i = clientIndex + 1; i < chain.length; i++) {
    if (!isTrustedAddress(chain[i], config)) return peer;
  }
  const client = chain[clientIndex];
  return isIP(client) ? normalizeIp(client) : peer;
}
