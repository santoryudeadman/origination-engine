// Serves the portfolio, and tells you whether a person actually read it.
//
// The problem with view counting: mail scanners, Slack unfurls and link-preview bots all fetch
// the URL. A single hit seconds after sending is almost always a robot. So this separates three
// events, weakest to strongest:
//
//   document  — the HTML was fetched. Could be anyone, including a scanner.
//   asset     — a sub-resource was fetched. A rendering browser does this; a scanner doesn't.
//   beacon    — JavaScript ran on the page. Scanners do not execute JS. This is a person.
//
// Read it back at /hits?token=… (the token is a Worker secret, never in this repo).
// No cookies, no IP addresses stored. Aggregate signals only.

const ASSET_RE = /\.(css|js|json|svg|png|webp|ico|woff2?)$/i;
const VERDICTS = ['touched-only', 'loaded-assets', 'rendered-in-a-browser'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/hits') {
      if (!env.HITS_TOKEN || url.searchParams.get('token') !== env.HITS_TOKEN) {
        return new Response('not found', { status: 404 });
      }
      return Response.json(await report(env), { headers: { 'cache-control': 'no-store' } });
    }

    // Fired by the page itself. Only a real JS runtime gets here.
    if (url.pathname === '/beacon' && request.method === 'POST') {
      ctx.waitUntil(recordBeacon(env, request));
      return new Response(null, { status: 204 });
    }

    // Per-recipient link. Serves the page in place, so the URL stays theirs and nothing
    // redirects through a third party.
    const tagged = /^\/r\/([a-z0-9._-]{1,64})$/i.exec(url.pathname);
    if (tagged) {
      ctx.waitUntil(record(env, request, tagged[1].toLowerCase(), '/', 'document'));
      return env.ASSETS.fetch(new URL('/', url).toString(), request);
    }

    ctx.waitUntil(record(env, request, null, url.pathname, ASSET_RE.test(url.pathname) ? 'asset' : 'document'));
    return env.ASSETS.fetch(request);
  },
};

function slugFrom(request) {
  const ref = request.headers.get('referer') || '';
  const m = /\/r\/([a-z0-9._-]{1,64})/i.exec(ref);
  return m ? m[1].toLowerCase() : null;
}

async function recordBeacon(env, request) {
  let body = {};
  try { body = await request.json(); } catch { /* a beacon without a body is still a signal */ }
  const now = Date.now();
  await env.HITS.put(
    `hit:${String(now).padStart(14, '0')}:${Math.random().toString(36).slice(2, 8)}`,
    JSON.stringify({
      t: new Date(now).toISOString(),
      slug: typeof body.slug === 'string' ? body.slug.toLowerCase().slice(0, 64) : slugFrom(request),
      path: '/',
      kind: 'beacon',
      ua: (request.headers.get('user-agent') || '').slice(0, 200),
      country: request.headers.get('cf-ipcountry') || null,
      viewport: Number(body.w) || null,
      timezone: typeof body.tz === 'string' ? body.tz.slice(0, 64) : null,
    }),
    { expirationTtl: 60 * 60 * 24 * 120 },
  );
}

async function record(env, request, slug, path, kind) {
  const now = Date.now();
  await env.HITS.put(
    // One key per request: concurrent writes to a shared key would race.
    `hit:${String(now).padStart(14, '0')}:${Math.random().toString(36).slice(2, 8)}`,
    JSON.stringify({
      t: new Date(now).toISOString(),
      slug,
      path,
      kind,
      ua: (request.headers.get('user-agent') || '').slice(0, 200),
      ref: (request.headers.get('referer') || '').slice(0, 200),
      country: request.headers.get('cf-ipcountry') || null,
    }),
    { expirationTtl: 60 * 60 * 24 * 120 },
  );
}

async function report(env) {
  const listed = await env.HITS.list({ prefix: 'hit:', limit: 1000 });
  const entries = (await Promise.all(listed.keys.map((k) => env.HITS.get(k.name, 'json')))).filter(Boolean);

  const bySlug = new Map();
  for (const e of entries) {
    const key = e.slug || '(direct — no /r/ tag)';
    if (!bySlug.has(key)) {
      bySlug.set(key, { slug: key, first: e.t, last: e.t, documents: 0, assets: 0, beacons: 0, agents: new Set(), countries: new Set(), zones: new Set() });
    }
    const s = bySlug.get(key);
    if (e.t < s.first) s.first = e.t;
    if (e.t > s.last) s.last = e.t;
    if (e.kind === 'beacon') s.beacons += 1;
    else if (e.kind === 'asset') s.assets += 1;
    else s.documents += 1;
    if (e.ua) s.agents.add(e.ua);
    if (e.country) s.countries.add(e.country);
    if (e.timezone) s.zones.add(e.timezone);
  }

  const visits = [...bySlug.values()]
    .map((s) => {
      const strength = s.beacons > 0 ? 2 : s.assets > 0 ? 1 : 0;
      return {
        slug: s.slug,
        first_seen: s.first,
        last_seen: s.last,
        page_views: s.documents,
        asset_requests: s.assets,
        js_beacons: s.beacons,
        verdict: VERDICTS[strength],
        distinct_user_agents: s.agents.size,
        user_agents: [...s.agents].slice(0, 4),
        countries: [...s.countries],
        timezones: [...s.zones],
      };
    })
    .sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));

  return {
    read_at: new Date().toISOString(),
    requests_logged: entries.length,
    how_to_read: {
      'touched-only': 'HTML fetched but nothing else — almost always a mail scanner or link preview.',
      'loaded-assets': 'sub-resources fetched, so something rendered it.',
      'rendered-in-a-browser': 'JavaScript ran. A person had it open.',
      'distinct_user_agents > 1': 'usually a scanner plus the actual person.',
    },
    visits,
  };
}
