// 랭킹 프로토콜의 서버 쪽 규칙: 브라우저 세션 쿠키, 발급 한도, 구간 시드 파생.
//
// 여기서 지키는 것은 "서버 발급 시드의 오프라인 최적화 범위를 한 구간으로 줄이고,
// 한 브라우저가 열 수 있는 판 수를 제한하는 것"까지다. 사람이 플레이했다는 보증은 하지 않는다.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { MAX_TICKS } from '../../shared/defs.ts';

export const SESSION_COOKIE = 'ember_sid';
export const SESSION_COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** 한 판이 가질 수 있는 최대 입력 프레임. 레벨업 선택 프레임 여유를 포함한다. */
export const MAX_RUN_FRAMES = MAX_TICKS + 4096;

export interface RankedLimits {
  /** 세션 하나가 동시에 열어 둘 수 있는 미제출 판. 넘기면 가장 오래된 판이 폐기된다. */
  sessionOpen: number;
  /** 세션이 windowMs 동안 발급받을 수 있는 판 수. 폐기·거절·검증 완료 판도 센다. */
  sessionWindow: number;
  windowMs: number;
  /** IP 보조 상한(공유 NAT를 고려해 세션 상한보다 크게 둔다). */
  ipOpen: number;
  ipWindow: number;
  /** IP 하나가 windowMs 동안 새로 만들 수 있는 세션 수. */
  ipNewSessions: number;
  /** 전체 상한. DB 크기와 대기 상태의 최악값을 묶는다. */
  maxSessions: number;
  maxOpenRuns: number;
  maxWindowRuns: number;
  /** 입력이 끊겨 이 시간이 지난 진행 중 판은 주기 정리에서 만료해 슬롯을 돌려받는다(구간 기한보다 길어야 한다). */
  idleMs: number;
  /**
   * 이미 공개한 구간 시드를 들고 있을 수 있는 시간: 그 구간의 정상 플레이 시간 + segmentGraceMs.
   * 고정 상한이다(클라이언트가 선언한 값으로 늘리지 않는다). 넘기면 그 판은 거절하고,
   * 클라이언트는 그 전에 서버 없이 로컬로 이어간다. 일시정지·레벨업 선택도 이 안에서만 허용된다.
   */
  segmentGraceMs: number;
  /** 발급 후 이 시간이 지난 판은 제출할 수 없다. */
  maxRunAgeMs: number;
  /** 랭킹 상위 몇 개 기록만 입력 리플레이를 보관할지. */
  boardKeep: number;
}

export const RANKED_LIMITS: RankedLimits = {
  sessionOpen: 3,
  sessionWindow: 6,
  windowMs: 30 * 60 * 1000,
  ipOpen: 20,
  ipWindow: 60,
  ipNewSessions: 10,
  maxSessions: 50_000,
  maxOpenRuns: 1000,
  maxWindowRuns: 3000,
  idleMs: 90 * 1000,
  segmentGraceMs: 5000,
  maxRunAgeMs: (MAX_TICKS / 60) * 1000 + 10 * 60 * 1000,
  boardKeep: 1000,
};

/** 발급 이력은 windowMs 동안 필요하다. 거절·폐기 행 보존 시간(2시간)이 그보다 짧으면 한도가 새어 나간다. */
export const RUN_RETENTION_MS = 2 * 60 * 60 * 1000;
export const SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** DB에는 토큰의 해시만 둔다. DB 파일이 새도 쿠키를 만들 수 없다. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function readSessionToken(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return TOKEN_RE.test(value) ? value : null;
  }
  return null;
}

export function sessionCookie(token: string, secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_COOKIE_MAX_AGE_S}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/** 구간 시드. 판마다 서버만 아는 secret에서 파생하므로 이전 구간 입력을 받기 전에는 클라이언트가 알 수 없다. */
export function segmentSeed(secret: Uint8Array, index: number): number {
  return createHmac('sha256', secret).update(`last-ember/segment/${index}`).digest().readInt32BE(0);
}

/** 인접한 같은 코드를 합쳐 RLE를 정규형으로 만든다. 같은 입력의 재전송을 문자열 비교로 알아보기 위함. */
export function normalizeRuns(runs: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < runs.length; i += 2) {
    const n = out.length;
    if (n > 0 && out[n - 2] === runs[i]) out[n - 1] += runs[i + 1];
    else out.push(runs[i], runs[i + 1]);
  }
  return out;
}
