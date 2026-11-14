// Trajectcontrole: haalt NS-reisadviezen en storingen op en bepaalt welke meldingen nieuw zijn.

const NS = 'https://gateway.apiportal.ns.nl';
const TZ = 'Europe/Amsterdam';
const VOORUIT_MIN = 45;      // meld problemen voor treinen die binnen zoveel minuten vertrekken
const AANLOOP_MIN = 45;      // begin zoveel minuten vóór het venster al met kijken
const OPNIEUW_BIJ_MIN = 5;   // opnieuw melden als vertraging zoveel minuten verder oploopt

const STATUS_LABEL = {
  CANCELLED: 'rijdt niet', CHANGE_NOT_POSSIBLE: 'overstap niet mogelijk', ALTERNATIVE_TRANSPORT: 'vervangend vervoer',
  DISRUPTION: 'storing', REPLACEMENT: 'vervangende trein', MAINTENANCE: 'werkzaamheden',
};

const pad = (n) => String(n).padStart(2, '0');
const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const diffMin = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : 0);

/** Lokale tijd in Amsterdam: weekdag (0=zo) en minuut van de dag. */
export function localNow(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { day, min: Number(parts.hour) * 60 + Number(parts.minute) };
}
export function hhmmLocal(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute}`;
}

export function shouldCheck(t, now) {
  return t.actief && t.dagen.includes(now.day) && now.min >= toMin(t.start) - AANLOOP_MIN && now.min <= toMin(t.eind);
}

async function ns(path, apiKey) {
  const res = await fetch(NS + path, { headers: { 'Ocp-Apim-Subscription-Key': apiKey } });
  if (!res.ok) throw new Error(`NS ${res.status} ${path.split('?')[0]}`);
  return res.json();
}

export function analyseTrip(trip, drempel) {
  const legs = (trip.legs || []).filter((l) => l.travelType !== 'WALK');
  const first = legs[0] || {};
  const last = legs[legs.length - 1] || {};
  const pDep = first.origin?.plannedDateTime;
  const aDep = first.origin?.actualDateTime || pDep;
  const pArr = last.destination?.plannedDateTime;
  const aArr = last.destination?.actualDateTime || pArr;
  const delay = Math.max(diffMin(pDep, aDep), diffMin(pArr, aArr), 0);
  const status = trip.status || 'NORMAL';
  const cancelled = status === 'CANCELLED' || legs.some((l) => l.cancelled);
  let sev = 'ok';
  if (cancelled || status === 'CHANGE_NOT_POSSIBLE') sev = 'uitval';
  else if (legs.some((l) => l.partCancelled) || ['DISRUPTION', 'ALTERNATIVE_TRANSPORT', 'REPLACEMENT'].includes(status)) sev = 'storing';
  else if (delay >= drempel) sev = 'vertraging';
  const msg = trip.primaryMessage?.message?.text || trip.primaryMessage?.title
    || (trip.messages || [])[0]?.text || legs.flatMap((l) => l.messages || [])[0]?.text || '';
  const products = legs.map((l) => l.product?.shortCategoryName || l.product?.displayName || l.name).filter(Boolean);
  return {
    key: String(trip.ctxRecon || trip.uid || `${pDep}-${products.join('/')}`).slice(-120),
    pDep, aDep, pArr, aArr, delay, status, sev, cancelled, msg, products,
    track: first.origin?.actualTrack || first.origin?.plannedTrack || '',
    trackChanged: !!(first.origin?.actualTrack && first.origin?.plannedTrack && first.origin.actualTrack !== first.origin.plannedTrack),
  };
}

function disruptionOnRoute(d, t) {
  const codes = new Set();
  (d.publicationSections || []).forEach((p) => (p.section?.stations || []).forEach((s) => s.stationCode && codes.add(s.stationCode.toUpperCase())));
  if (!codes.size) return true;
  return codes.has(t.van.code.toUpperCase()) && codes.has(t.naar.code.toUpperCase());
}

function tripLine(a) {
  const dep = hhmmLocal(a.pDep);
  const prod = a.products.join(' + ') || 'Trein';
  if (a.cancelled) return `${prod} van ${dep} rijdt niet.`;
  const vertrek = a.delay > 0 ? `${dep} → ${hhmmLocal(a.aDep)}` : dep;
  return `${prod} ${vertrek}${a.track ? `, spoor ${a.track}${a.trackChanged ? ' (gewijzigd)' : ''}` : ''}. Aankomst ${hhmmLocal(a.aArr)}.`;
}

/**
 * Controleer één apparaat. Geeft { meldingen, notified, changed } terug.
 * notified: { [key]: { sev, delay, ts } } voor ontdubbeling.
 */
export async function checkDevice(dev, nowDate = new Date()) {
  const now = localNow(nowDate);
  const notified = { ...(dev.notified || {}) };
  const meldingen = [];
  let changed = false;
  const errors = [];
  const doDisruptions = nowDate.getUTCMinutes() % 5 === 0;
  const stationCache = new Map();

  for (const t of dev.trajecten || []) {
    if (!shouldCheck(t, now)) continue;
    try {
      const data = await ns(`/reisinformatie-api/api/v3/trips?fromStation=${encodeURIComponent(t.van.code)}&toStation=${encodeURIComponent(t.naar.code)}&lang=nl`, dev.apiKey);
      const eindToday = toMin(t.eind);
      const trips = (data.trips || []).map((tr) => analyseTrip(tr, t.drempel || 5)).filter((a) => {
        if (!a.pDep) return false;
        const minsAway = (new Date(a.aDep) - nowDate) / 60000;
        const depLocal = localNow(new Date(a.pDep)).min;
        return minsAway >= -1 && minsAway <= VOORUIT_MIN && depLocal >= toMin(t.start) && depLocal <= eindToday;
      });

      for (let i = 0; i < trips.length; i++) {
        const a = trips[i];
        if (a.sev === 'ok') continue;
        const key = `${t.id}|${a.key}`;
        const prev = notified[key];
        const nieuw = !prev || prev.sev !== a.sev || (a.sev === 'vertraging' && a.delay >= prev.delay + OPNIEUW_BIJ_MIN);
        if (!nieuw) continue;
        const alt = trips.slice(i + 1).find((b) => b.sev === 'ok') || null;
        const wat = a.cancelled ? 'rijdt niet' : a.sev === 'vertraging' ? `+${a.delay} min` : (STATUS_LABEL[a.status] || 'storing');
        let body = tripLine(a);
        if (a.msg) body += ` ${a.msg}`;
        if (alt) body += `\nAlternatief: ${hhmmLocal(alt.aDep)} → ${hhmmLocal(alt.aArr)}${alt.track ? `, spoor ${alt.track}` : ''}.`;
        meldingen.push({ title: `${t.naam}: ${wat}`, body, tag: key, sev: a.sev });
        notified[key] = { sev: a.sev, delay: a.delay, ts: Date.now() };
        changed = true;
      }

      if (doDisruptions) {
        if (!stationCache.has(t.van.code)) {
          stationCache.set(t.van.code, ns(`/disruptions/v3/station/${encodeURIComponent(t.van.code)}`, dev.apiKey).catch(() => []));
        }
        const list = await stationCache.get(t.van.code);
        for (const d of (Array.isArray(list) ? list : [])) {
          if (d.isActive === false || d.type === 'MAINTENANCE' || !disruptionOnRoute(d, t)) continue;
          const key = `${t.id}|dis|${d.id}`;
          if (notified[key]) continue;
          const ts = (d.timespans || [])[0] || {};
          const body = [ts.situation?.label, ts.cause?.label && `Oorzaak: ${ts.cause.label}`, d.expectedDuration?.description].filter(Boolean).join('\n');
          meldingen.push({ title: `${t.naam}: ${d.type === 'CALAMITY' ? 'calamiteit' : 'storing'}`, body: `${d.title || ''}${body ? `\n${body}` : ''}`, tag: key, sev: 'storing' });
          notified[key] = { sev: 'storing', delay: 0, ts: Date.now() };
          changed = true;
        }
      }
    } catch (err) {
      errors.push(`${t.naam}: ${err.message}`);
    }
  }

  // oude ontdubbel-sleutels opruimen (> 8 uur)
  const grens = Date.now() - 8 * 3600 * 1000;
  for (const [k, v] of Object.entries(notified)) {
    if (v.ts < grens) { delete notified[k]; changed = true; }
  }
  return { meldingen, notified, changed, errors };
}
