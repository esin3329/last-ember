// LAST EMBER 서비스 워커 템플릿. 빌드 시 scripts/vite-pwa.ts가 버전과 precache 목록 자리표시자를 채워 dist/sw.js로 내보낸다.
// 전략: 빌드 산출물 전체를 버전별 캐시에 미리 받아 두고(precache) 그 캐시에서만 응답한다.
// - 새 버전은 자기 캐시를 따로 채우고 skipWaiting을 하지 않는다. 열려 있는 탭이 모두 닫힌 뒤에야 활성화되므로
//   한 화면이 이전/새 빌드 자산을 섞어 쓰지 않는다. 이전 캐시는 활성화 때 지운다.
// - /api/ 는 가로채지 않는다(랭킹은 항상 네트워크, 실패 시 앱의 기존 오프라인 처리).
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;

const CACHE_PREFIX = 'last-ember-';
const CACHE = CACHE_PREFIX + VERSION;
const SCOPE = self.registration.scope; // 항상 '/'로 끝난다. 루트든 /last-ember/든 동일하게 동작.
const API_PREFIX = new URL('api/', SCOPE).href;
const ENTRY = new URL('index.html', SCOPE).href;
const ROOT = new URL('./', SCOPE).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        await Promise.all(
          PRECACHE.map(async (path) => {
            const url = new URL(path, SCOPE).href;
            // HTTP 캐시를 우회해 배포된 최신 파일을 받는다. 하나라도 실패하면 설치 전체가 실패하고 이전 버전이 유지된다.
            const res = await fetch(url, { cache: 'reload' });
            if (!res.ok) throw new Error(`precache ${res.status}: ${url}`);
            await cache.put(url, res);
          }),
        );
      } catch (err) {
        await caches.delete(CACHE);
        throw err;
      }
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.href.startsWith(SCOPE) || url.href.startsWith(API_PREFIX)) return;
  const isEntry = url.href.split(/[?#]/)[0] === ROOT || url.href.split(/[?#]/)[0] === ENTRY;
  if (req.mode === 'navigate' && !isEntry) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // 캐시에는 정적 빌드 파일만 있다. precache와 모듈 요청의 Origin 헤더가
      // 달라도 Vary: Origin을 붙이는 호스트에서 같은 파일을 오프라인으로 제공한다.
      const hit = await cache.match(req.mode === 'navigate' ? ENTRY : req, { ignoreSearch: true, ignoreVary: true });
      return hit ?? fetch(req);
    })(),
  );
});
