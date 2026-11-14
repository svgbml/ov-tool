// OV-tool Worker: serveert de webapp, beheert push-aanmeldingen en controleert elke minuut de trajecten.
import { sendWebPush } from './webpush.js';
import { checkDevice } from './check.js';

const KV_KEY = 'devices';
const MAX_DEVICES = 10;

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
});
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function loadDevices(env) {
  return (await env.KV.get(KV_KEY, 'json')) || {};
}
async function saveDevices(env, devices) {
  await env.KV.put(KV_KEY, JSON.stringify(devices));
}

function vapid(env) {
  return { publicKey: env.VAPID_PUBLIC, privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), subject: env.VAPID_SUBJECT };
}

function validTraject(t) {
  return t && typeof t.id === 'string' && t.van?.code && t.naar?.code && Array.isArray(t.dagen)
    && /^\d{2}:\d{2}$/.test(t.start) && /^\d{2}:\d{2}$/.test(t.eind);
}
function cleanTraject(t) {
  return {
    id: String(t.id).slice(0, 40), naam: String(t.naam || `${t.van.naam} → ${t.naar.naam}`).slice(0, 80),
    van: { code: String(t.van.code).slice(0, 8), naam: String(t.van.naam || t.van.code).slice(0, 60) },
    naar: { code: String(t.naar.code).slice(0, 8), naam: String(t.naar.naam || t.naar.code).slice(0, 60) },
    dagen: t.dagen.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
    start: t.start, eind: t.eind, drempel: Math.max(1, Math.min(60, Number(t.drempel) || 5)), actief: !!t.actief,
  };
}

async function push(env, sub, msg) {
  const payload = JSON.stringify({ title: msg.title, body: msg.body, tag: msg.tag, url: '/' });
  return sendWebPush(sub, payload, { ...vapid(env), topic: msg.tag, urgency: 'high', ttl: 900 });
}

async function handleApi(req, env, url) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const path = url.pathname.replace(/^\/api/, '');

  if (path === '/vapid' && req.method === 'GET') return json({ publicKey: env.VAPID_PUBLIC }, 200, CORS);

  if (req.method !== 'POST') return json({ error: 'Niet gevonden' }, 404, CORS);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Ongeldige JSON' }, 400, CORS); }
  const id = String(body.id || '');
  if (!/^[A-Za-z0-9-]{16,64}$/.test(id)) return json({ error: 'Ongeldig apparaat-id' }, 400, CORS);

  const devices = await loadDevices(env);

  if (path === '/register') {
    const sub = body.subscription;
    if (!sub?.endpoint?.startsWith('https://') || !sub.keys?.p256dh || !sub.keys?.auth) return json({ error: 'Ongeldig push-abonnement' }, 400, CORS);
    if (!body.apiKey) return json({ error: 'NS API-sleutel ontbreekt' }, 400, CORS);
    const trajecten = (body.trajecten || []).filter(validTraject).map(cleanTraject).slice(0, 12);
    if (!devices[id] && Object.keys(devices).length >= MAX_DEVICES) return json({ error: 'Maximum aantal apparaten bereikt' }, 403, CORS);
    devices[id] = {
      subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
      apiKey: String(body.apiKey).slice(0, 100),
      trajecten,
      notified: devices[id]?.notified || {},
      updated: Date.now(),
    };
    await saveDevices(env, devices);
    return json({ ok: true, trajecten: trajecten.length }, 200, CORS);
  }

  const dev = devices[id];
  if (!dev) return json({ error: 'Apparaat niet aangemeld' }, 404, CORS);

  if (path === '/unregister') {
    delete devices[id];
    await saveDevices(env, devices);
    return json({ ok: true }, 200, CORS);
  }
  if (path === '/test') {
    let res;
    try {
      res = await push(env, dev.subscription, {
        title: 'OV-tool: meldingen werken', body: `Je ontvangt meldingen voor ${dev.trajecten.filter((t) => t.actief).length} actieve traject(en).`, tag: 'test',
      });
    } catch (e) {
      return json({ ok: false, error: `Push-dienst niet bereikbaar: ${e.message}` }, 502, CORS);
    }
    if (res.status === 404 || res.status === 410) { delete devices[id]; await saveDevices(env, devices); }
    return json({ ok: res.ok, status: res.status }, res.ok ? 200 : 502, CORS);
  }
  if (path === '/status') {
    return json({ ok: true, trajecten: dev.trajecten.length, updated: dev.updated }, 200, CORS);
  }
  return json({ error: 'Niet gevonden' }, 404, CORS);
}

async function runChecks(env, now = new Date()) {
  const devices = await loadDevices(env);
  let dirty = false;
  const log = [];
  for (const [id, dev] of Object.entries(devices)) {
    const { meldingen, notified, changed, errors } = await checkDevice(dev, now);
    if (errors.length) log.push(...errors);
    for (const m of meldingen) {
      try {
        const res = await push(env, dev.subscription, m);
        if (res.status === 404 || res.status === 410) { delete devices[id]; dirty = true; break; }
        if (!res.ok) log.push(`push ${res.status}`);
      } catch (e) { log.push(`push fout: ${e.message}`); }
    }
    if (changed && devices[id]) { devices[id].notified = notified; dirty = true; }
  }
  if (dirty) await saveDevices(env, devices);
  if (log.length) console.log(log.join(' | '));
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return handleApi(req, env, url);
    return env.ASSETS.fetch(req);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runChecks(env, new Date(event.scheduledTime)));
  },
};

export { runChecks };
