// Only /api/* runs at the edge; Pages serves the game and PWA assets directly.
export async function onRequest({ request, env }) {
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (!clientIp || !env.PAGES_PROXY_TOKEN) {
    return Response.json({ error: 'api_proxy_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  const upstream = new URL(env.PAGES_API_ORIGIN);
  const incoming = new URL(request.url);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  const headers = new Headers({
    'X-Ember-Proxy-Token': env.PAGES_PROXY_TOKEN,
    'X-Ember-Client-IP': clientIp,
  });
  for (const name of ['content-type', 'cookie', 'sec-fetch-site']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  try {
    const response = await fetch(upstream, { method: request.method, headers, body: request.body, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) throw new Error('Unexpected API redirect');
    const result = new Response(response.body, response);
    result.headers.set('Cache-Control', 'no-store');
    return result;
  } catch {
    return Response.json({ error: 'api_upstream_unavailable' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
