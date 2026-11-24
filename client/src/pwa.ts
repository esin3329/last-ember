// 서비스 워커 등록(프로덕션 빌드 전용). 상대 경로라 루트와 /last-ember/ 하위 경로 모두에서 같은 방식으로 동작한다.
// 등록 실패는 게임 실행에 영향이 없다: 오프라인 캐시만 없는 일반 웹페이지로 계속 동작한다.
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', document.baseURI)).catch((err) => console.warn('서비스 워커 등록 실패', err));
  });
}
