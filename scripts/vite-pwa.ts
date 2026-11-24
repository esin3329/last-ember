// 빌드 산출물(dist) 전체를 훑어 서비스 워커 precache 목록과 버전 해시를 만들어 dist/sw.js로 쓴다.
// 파일 이름·내용이 하나라도 바뀌면 VERSION이 바뀌므로 브라우저가 새 서비스 워커로 인식한다.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

// 게임 실행에 필요 없는 파일: 서비스 워커 자신, 링크 미리보기용 대표 이미지.
const EXCLUDE = new Set(['sw.js', 'last-ember-cover.png']);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

export function pwa(): Plugin {
  let outDir = '';
  return {
    name: 'last-ember-pwa',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const template = readFileSync(fileURLToPath(new URL('./pwa-sw.js', import.meta.url)), 'utf8');
      const files = walk(outDir)
        .map((f) => relative(outDir, f).split(sep).join('/'))
        .filter((f) => !EXCLUDE.has(f))
        .sort();
      const hash = createHash('sha256').update(template);
      for (const f of files) hash.update(f).update('\0').update(readFileSync(join(outDir, f)));
      const version = hash.digest('hex').slice(0, 12);
      // './'는 스코프 루트(디렉터리 URL), 나머지는 스코프 기준 상대 경로.
      const precache = ['./', ...files];
      writeFileSync(join(outDir, 'sw.js'), template.replace('__VERSION__', () => version).replace('__PRECACHE__', () => JSON.stringify(precache, null, 2)));
    },
  };
}
