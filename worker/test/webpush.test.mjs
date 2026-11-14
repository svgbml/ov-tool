import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, webcrypto } from 'node:crypto';
import ece from 'http_ece';
import { encryptPayload, vapidJwt, b64u } from '../src/webpush.js';
import { analyseTrip, localNow, shouldCheck, checkDevice } from '../src/check.js';

test('aes128gcm-payload is te ontsleutelen door de ontvanger (RFC 8291)', async () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  const body = await encryptPayload(b64u.enc(ua.getPublicKey()), b64u.enc(auth), '{"title":"Hallo","body":"+7 min"}');
  const plain = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ua, authSecret: auth.toString('base64url') });
  assert.equal(plain.toString(), '{"title":"Hallo","body":"+7 min"}');
});

test('VAPID-JWT heeft geldige ES256-handtekening en juiste claims', async () => {
  const k = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', k.privateKey);
  const jwt = await vapidJwt('https://fcm.googleapis.com', 'https://github.com/svgbml/ov-tool', jwk);
  const [h, p, s] = jwt.split('.');
  const ok = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k.publicKey, b64u.dec(s), new TextEncoder().encode(`${h}.${p}`));
  assert.ok(ok);
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.ok(claims.exp > Date.now() / 1000);
});

test('lokale tijd Amsterdam (wintertijd)', () => {
  const n = localNow(new Date('2026-11-18T07:00:00Z'));
  assert.deepEqual(n, { day: 3, min: 8 * 60 });
});

test('venster met aanloop', () => {
  const t = { actief: true, dagen: [1, 2, 3, 4, 5], start: '07:30', eind: '19:00' };
  assert.ok(shouldCheck(t, { day: 3, min: 6 * 60 + 50 }));
  assert.ok(!shouldCheck(t, { day: 3, min: 6 * 60 + 40 }));
  assert.ok(!shouldCheck(t, { day: 6, min: 9 * 60 }));
  assert.ok(!shouldCheck(t, { day: 3, min: 19 * 60 + 1 }));
});

const iso = (h, m) => `2026-11-18T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+0100`;
function trip(h, m, delay, opts = {}) {
  const tot = h * 60 + m + delay;
  return {
    ctxRecon: opts.ctx || `${h}${m}`, status: opts.status || 'NORMAL',
    legs: [{ cancelled: !!opts.cancel, product: { shortCategoryName: 'IC' },
      origin: { plannedDateTime: iso(h, m), actualDateTime: iso(Math.floor(tot / 60), tot % 60), plannedTrack: '3', actualTrack: opts.track || '3' },
      destination: { plannedDateTime: iso(h, m + 15), actualDateTime: iso(Math.floor((tot + 15) / 60), (tot + 15) % 60) } }],
  };
}

test('analyseTrip: uitval / vertraging / ok', () => {
  assert.equal(analyseTrip(trip(8, 4, 0, { status: 'CANCELLED', cancel: true }), 5).sev, 'uitval');
  assert.equal(analyseTrip(trip(8, 10, 7), 5).sev, 'vertraging');
  assert.equal(analyseTrip(trip(8, 10, 3), 5).sev, 'ok');
});

test('checkDevice: meldt nieuwe problemen één keer, met alternatief, en opnieuw bij oplopende vertraging', async () => {
  let delay = 7;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/trips')) {
      return new Response(JSON.stringify({ trips: [trip(8, 4, 0, { status: 'CANCELLED', cancel: true, ctx: 'a' }), trip(8, 10, delay, { ctx: 'b', track: '5' }), trip(8, 19, 0, { ctx: 'c' })] }));
    }
    return new Response('[]');
  };
  const dev = { apiKey: 'x', trajecten: [{ id: 't1', naam: 'Tilburg → Breda', van: { code: 'TB', naam: 'Tilburg' }, naar: { code: 'BD', naam: 'Breda' }, dagen: [3], start: '07:30', eind: '19:00', drempel: 5, actief: true }], notified: {} };
  const now = new Date('2026-11-18T07:00:30Z'); // 08:00:30 lokaal
  const r1 = await checkDevice(dev, now);
  assert.equal(r1.meldingen.length, 2);
  assert.match(r1.meldingen[0].title, /rijdt niet/);
  assert.match(r1.meldingen[0].body, /Alternatief: 08:19 → 08:34/);
  assert.match(r1.meldingen[1].title, /\+7 min/);
  assert.match(r1.meldingen[1].body, /spoor 5 \(gewijzigd\)/);

  const r2 = await checkDevice({ ...dev, notified: r1.notified }, now);
  assert.equal(r2.meldingen.length, 0, 'geen dubbele meldingen');

  delay = 13;
  const r3 = await checkDevice({ ...dev, notified: r1.notified }, now);
  assert.equal(r3.meldingen.length, 1);
  assert.match(r3.meldingen[0].title, /\+13 min/);
});
