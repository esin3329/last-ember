// 빌드된 클라이언트(dist) 정적 파일 서빙. 서버 하나로 배포할 수 있게 한다.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

export async function serveStatic(root: string, urlPath: string, res: ServerResponse): Promise<boolean> {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  // 경로 탈출(../) 차단: 정규화한 뒤에도 root 안에 있는지 확인한다.
  const file = normalize(join(root, rel));
  if (!file.startsWith(root + sep)) return false;
  try {
    const st = await stat(file);
    if (!st.isFile()) return false;
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}
