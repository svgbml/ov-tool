'use strict';

/* OV-tool – vaste treintrajecten bewaken via de NS-API.
 * Alles draait in de browser; trajecten en API-sleutel staan in localStorage. */

const API_BASE = 'https://gateway.apiportal.ns.nl';
const STORE_KEY = 'ovtool.v1';
const DAGEN = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const DAG_VOLGORDE = [1, 2, 3, 4, 5, 6, 0];

/* ---------- helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const minOfDay = (d) => d.getHours() * 60 + d.getMinutes();
const parseDate = (s) => (s ? new Date(s) : null);
const diffMin = (a, b) => (a && b ? Math.round((parseDate(b) - parseDate(a)) / 60000) : 0);

function toNsDateTime(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${oh}:${om}`;
}

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ---------- state ---------- */
function defaultTrajecten() {
  const basis = { dagen: [1, 2, 3, 4, 5], start: '07:30', eind: '19:00', drempel: 5, actief: true };
  return [
    { id: uid(), naam: 'Tilburg → Breda', van: { code: 'TB', naam: 'Tilburg' }, naar: { code: 'BD', naam: 'Breda' }, ...basis },
    { id: uid(), naam: 'Breda → Tilburg', van: { code: 'BD', naam: 'Breda' }, naar: { code: 'TB', naam: 'Tilburg' }, ...basis },
  ];
}
function defaultState() {
  return { apiKey: '', settings: { refreshSec: 120, aantal: 4, notify: false }, trajecten: defaultTrajecten() };
}

let memoryFallback = null;
function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    const d = defaultState();
    return { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) }, trajecten: Array.isArray(s.trajecten) ? s.trajecten : d.trajecten };
  } catch {
    return memoryFallback || defaultState();
  }
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch { memoryFallback = structuredClone(state); }
}
let state = loadState();

/* ---------- NS API ---------- */
class ApiError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}
async function api(path, params = {}) {
  if (!state.apiKey) throw new ApiError('Geen API-sleutel ingesteld', 'nokey');
  const url = new URL(API_BASE + path);
  Object.entries(params).forEach(([k, v]) => v !== undefined && url.searchParams.set(k, v));
  let res;
  try {
    res = await fetch(url, { headers: { 'Ocp-Apim-Subscription-Key': state.apiKey } });
  } catch {
    throw new ApiError('Geen verbinding met de NS-API', 'network');
  }
  if (res.status === 401 || res.status === 403) throw new ApiError(`API-sleutel ongeldig of geen toegang (${res.status})`, 'auth');
  if (res.status === 429) throw new ApiError('Te veel verzoeken (429), probeer het zo opnieuw', 'rate');
  if (!res.ok) throw new ApiError(`NS-API gaf fout ${res.status}`, 'http');
  return res.json();
}

const getTrips = (t, when) =>
  api('/reisinformatie-api/api/v3/trips', {
    fromStation: t.van.code, toStation: t.naar.code, dateTime: toNsDateTime(when), lang: 'nl',
  }).then((r) => r.trips || []);

async function getStationDisruptions(code) {
  const r = await api(`/disruptions/v3/station/${encodeURIComponent(code)}`);
  return Array.isArray(r) ? r : (r.payload || r.disruptions || []);
}

async function searchStations(q) {
  const r = await api('/nsapp-stations/v3', { q, limit: 8 });
  const list = Array.isArray(r) ? r : (r.payload || []);
  return list.map((s) => ({
    code: s.id?.code || s.code || s.stationCode || '',
    naam: s.names?.long || s.names?.medium || s.namen?.lang || s.name || '',
  })).filter((s) => s.code && s.naam);
}

/* ---------- analyse ---------- */
const STATUS_LABEL = {
  NORMAL: 'Op tijd',
  CANCELLED: 'Rijdt niet',
  CHANGE_NOT_POSSIBLE: 'Overstap niet mogelijk',
  CHANGE_COULD_BE_POSSIBLE: 'Overstap misschien mogelijk',
  ALTERNATIVE_TRANSPORT: 'Vervangend vervoer',
  DISRUPTION: 'Storing',
  MAINTENANCE: 'Werkzaamheden',
  UNCERTAIN: 'Onzeker',
  REPLACEMENT: 'Vervangende trein',
  ADDITIONAL: 'Extra trein',
  SPECIAL: 'Bijzonderheid',
  NOT_OPTIMAL: 'Niet optimaal',
};

function analyseTrip(trip, drempel) {
  const legs = (trip.legs || []).filter((l) => l.travelType !== 'WALK');
  const first = legs[0] || {};
  const last = legs[legs.length - 1] || {};
  const pDep = first.origin?.plannedDateTime;
  const aDep = first.origin?.actualDateTime || pDep;
  const pArr = last.destination?.plannedDateTime;
  const aArr = last.destination?.actualDateTime || pArr;
  const depDelay = diffMin(pDep, aDep);
  const arrDelay = diffMin(pArr, aArr);
  const delay = Math.max(depDelay, arrDelay, 0);
  const status = trip.status || 'NORMAL';
  const cancelled = status === 'CANCELLED' || legs.some((l) => l.cancelled);
  const partCancelled = legs.some((l) => l.partCancelled);

  const msgs = new Set();
  const add = (m) => { const t = typeof m === 'string' ? m : (m?.text || m?.title || m?.message?.text); if (t) msgs.add(t.trim()); };
  add(trip.primaryMessage?.message);
  add(trip.primaryMessage?.title);
  (trip.messages || []).forEach(add);
  legs.forEach((l) => (l.messages || []).forEach(add));

  let sev = 'ok';
  if (cancelled || status === 'CHANGE_NOT_POSSIBLE') sev = 'uitval';
  else if (partCancelled || ['DISRUPTION', 'ALTERNATIVE_TRANSPORT', 'REPLACEMENT'].includes(status)) sev = 'storing';
  else if (delay >= drempel) sev = 'vertraging';

  const products = legs.map((l) => l.product?.shortCategoryName || l.product?.displayName || l.name).filter(Boolean);
  const transfers = trip.transfers ?? Math.max(legs.length - 1, 0);
  const pTrack = first.origin?.plannedTrack;
  const aTrack = first.origin?.actualTrack || pTrack;

  return {
    key: trip.ctxRecon || trip.uid || `${pDep}-${products.join('/')}`,
    pDep, aDep, pArr, aArr, depDelay, arrDelay, delay, status, sev, cancelled,
    msgs: [...msgs], products, transfers, pTrack, aTrack,
    duur: trip.actualDurationInMinutes ?? trip.plannedDurationInMinutes,
    direction: first.direction,
  };
}

const SEV_ORDER = { ok: 0, vertraging: 1, storing: 2, uitval: 3 };
const worst = (a, b) => (SEV_ORDER[a] >= SEV_ORDER[b] ? a : b);

function disruptionStations(d) {
  const codes = new Set();
  (d.publicationSections || []).forEach((p) => (p.section?.stations || []).forEach((s) => s.stationCode && codes.add(s.stationCode.toUpperCase())));
  return codes;
}
function disruptionOnRoute(d, t) {
  const codes = disruptionStations(d);
  if (!codes.size) return true; // onbekend: tonen
  return codes.has(t.van.code.toUpperCase()) && codes.has(t.naar.code.toUpperCase());
}
function disruptionInfo(d) {
  const ts = (d.timespans || [])[0] || {};
  return {
    id: d.id,
    type: d.type,
    title: d.title || d.titel || 'Melding',
    detail: [ts.situation?.label, ts.cause?.label && `Oorzaak: ${ts.cause.label}`].filter(Boolean).join(' · ') || d.description || '',
    duur: d.expectedDuration?.description || '',
    extra: d.summaryAdditionalTravelTime?.label || '',
  };
}

/* ---------- vensters ---------- */
function inWindow(t, d = new Date()) {
  return t.dagen.includes(d.getDay()) && minOfDay(d) >= toMin(t.start) && minOfDay(d) <= toMin(t.eind);
}
function nextWindowStart(t, from = new Date()) {
  for (let i = 0; i < 8; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    const [h, m] = t.start.split(':').map(Number);
    d.setHours(h, m, 0, 0);
    if (!t.dagen.includes(d.getDay())) continue;
    if (i === 0 && minOfDay(from) >= toMin(t.start)) continue;
    return d;
  }
  return null;
}
function windowEndFor(t, day) {
  const d = new Date(day);
  const [h, m] = t.eind.split(':').map(Number);
  d.setHours(h, m, 59, 0);
  return d;
}
function dagenTekst(dagen) {
  const s = [...dagen].sort((a, b) => DAG_VOLGORDE.indexOf(a) - DAG_VOLGORDE.indexOf(b));
  const key = s.join(',');
  if (key === '1,2,3,4,5') return 'ma–vr';
  if (key === '1,2,3,4,5,6,0') return 'elke dag';
  if (key === '6,0') return 'weekend';
  return s.map((d) => DAGEN[d]).join(', ') || 'geen dagen';
}
function fmtDay(d) {
  const now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return 'vandaag';
  if (d.toDateString() === tomorrow.toDateString()) return 'morgen';
  return d.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'short' });
}

/* ---------- tabs ---------- */
function showTab(name) {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'live') refreshLive();
  if (name === 'trajecten') renderTrajecten();
  if (name === 'instellingen') fillSettings();
}
$$('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-goto]');
  if (a) { e.preventDefault(); showTab(a.dataset.goto); }
});

/* ---------- LIVE ---------- */
const notified = new Set();
let refreshing = false;

async function refreshLive() {
  const list = $('#live-list');
  $('#nokey-banner').classList.toggle('hidden', !!state.apiKey);
  const actieve = state.trajecten.filter((t) => t.actief);
  if (!actieve.length) {
    list.innerHTML = '<div class="card empty">Geen actieve trajecten. Voeg er een toe onder <a href="#" data-goto="trajecten">Trajecten</a>.</div>';
    return;
  }
  if (!state.apiKey) {
    list.innerHTML = actieve.map((t) => cardShell(t, 'fout', 'Geen sleutel', '<p class="empty">Stel eerst een NS API-sleutel in.</p>')).join('');
    return;
  }
  if (refreshing) return;
  refreshing = true;
  $('#btn-refresh').disabled = true;
  list.innerHTML = actieve.map((t) => cardShell(t, 'laden', 'Laden…', '<p class="empty">Gegevens ophalen…</p>')).join('');

  const stationCache = new Map();
  const disruptionsFor = (code) => {
    if (!stationCache.has(code)) stationCache.set(code, getStationDisruptions(code).catch(() => []));
    return stationCache.get(code);
  };

  await Promise.all(actieve.map(async (t) => {
    const el = $(`[data-tid="${t.id}"]`);
    try {
      const html = await renderTrajectCard(t, disruptionsFor);
      if (el) el.outerHTML = html;
    } catch (err) {
      if (el) el.outerHTML = cardShell(t, 'fout', 'Fout', `<p class="error">${esc(err.message)}</p>`);
    }
  }));

  $('#last-update').textContent = `Bijgewerkt om ${hhmm(new Date())}`;
  $('#btn-refresh').disabled = false;
  refreshing = false;
}

function cardShell(t, pillClass, pillText, body) {
  return `<article class="card tcard" data-tid="${esc(t.id)}">
    <div class="tcard-head"><h2>${esc(t.naam)}</h2><span class="pill ${pillClass}">${esc(pillText)}</span></div>
    <div class="tcard-sub">${esc(t.van.naam)} (${esc(t.van.code)}) → ${esc(t.naar.naam)} (${esc(t.naar.code)}) · ${esc(dagenTekst(t.dagen))} ${esc(t.start)}–${esc(t.eind)} · melden ≥ ${esc(t.drempel)} min</div>
    ${body}
  </article>`;
}

async function renderTrajectCard(t, disruptionsFor) {
  const now = new Date();
  const actiefNu = inWindow(t, now);
  const vanaf = actiefNu ? now : nextWindowStart(t, now);
  if (!vanaf) return cardShell(t, 'buiten', 'Geen dagen', '<p class="empty">Er zijn geen dagen geselecteerd voor dit traject.</p>');
  const eind = windowEndFor(t, vanaf);

  const [trips, dVan, dNaar] = await Promise.all([getTrips(t, vanaf), disruptionsFor(t.van.code), disruptionsFor(t.naar.code)]);

  const analysed = trips
    .map((tr) => analyseTrip(tr, t.drempel))
    .filter((a) => a.pDep && parseDate(a.pDep) <= eind && parseDate(a.aDep) >= new Date(now.getTime() - 60000))
    .slice(0, Number(state.settings.aantal) || 4);

  // storingen: ontdubbelen en splitsen in "op traject" en "rond station"
  const seen = new Set();
  const all = [...dVan, ...dNaar].filter((d) => d && d.isActive !== false && !seen.has(d.id) && seen.add(d.id));
  const onRoute = all.filter((d) => disruptionOnRoute(d, t)).map(disruptionInfo);
  const other = all.filter((d) => !disruptionOnRoute(d, t)).map(disruptionInfo);

  // status bepalen op basis van de eerstvolgende trein + storingen
  let sev = analysed[0]?.sev || 'ok';
  if (onRoute.some((d) => d.type !== 'MAINTENANCE')) sev = worst(sev, 'storing');

  // alternatief: eerste goede trein na een probleemtrein
  let altKey = null;
  if (analysed[0] && analysed[0].sev !== 'ok') {
    const alt = analysed.slice(1).find((a) => a.sev === 'ok' || (a.sev === 'vertraging' && a.delay < analysed[0].delay));
    if (alt) altKey = alt.key;
  }

  if (actiefNu) maybeNotify(t, analysed, onRoute, altKey);

  const pill = actiefNu
    ? { ok: ['ok', 'Geen problemen'], vertraging: ['vertraging', 'Vertraging'], storing: ['storing', 'Storing'], uitval: ['uitval', 'Uitval'] }[sev]
    : ['buiten', `Volgende: ${fmtDay(vanaf)} ${hhmm(vanaf)}`];

  const intro = actiefNu ? '' : `<p class="empty">Buiten het venster. Eerste treinen ${esc(fmtDay(vanaf))} vanaf ${esc(t.start)}:</p>`;
  const tripsHtml = analysed.length
    ? `<ul class="trips">${analysed.map((a) => tripRow(a, a.key === altKey)).join('')}</ul>`
    : '<p class="empty">Geen treinen meer binnen het venster.</p>';

  const disHtml = (onRoute.length ? `<div class="disruptions">${onRoute.map(disruptionRow).join('')}</div>` : '')
    + (other.length ? `<details class="other"><summary>${other.length} andere melding(en) rond ${esc(t.van.naam)}/${esc(t.naar.naam)}</summary>${other.map(disruptionRow).join('')}</details>` : '');

  return cardShell(t, pill[0], pill[1], intro + tripsHtml + disHtml);
}

function tripRow(a, isAlt) {
  const dep = parseDate(a.pDep);
  const act = parseDate(a.aDep);
  const late = a.depDelay > 0;
  const time = a.cancelled
    ? `<span class="late"><s>${hhmm(dep)}</s></span>`
    : late ? `<s>${hhmm(dep)}</s><span class="late">${hhmm(act)}</span>` : hhmm(dep);
  const arr = a.aArr ? hhmm(parseDate(a.aArr)) : '';
  const track = a.aTrack ? `spoor ${esc(a.aTrack)}${a.pTrack && a.aTrack !== a.pTrack ? ' (gewijzigd)' : ''}` : '';
  const meta = [arr && `aankomst ${arr}`, a.duur && `${a.duur} min`, a.transfers ? `${a.transfers}× overstap` : 'direct', track].filter(Boolean).join(' · ');
  const badge = a.cancelled ? 'Rijdt niet'
    : a.sev === 'ok' ? (a.delay > 0 ? `+${a.delay} min` : 'Op tijd')
    : a.sev === 'vertraging' ? `+${a.delay} min`
    : (STATUS_LABEL[a.status] || 'Storing');
  const msg = a.msgs.length && a.sev !== 'ok' ? `<div class="msg">${esc(a.msgs.slice(0, 2).join(' · '))}</div>` : '';
  return `<li class="trip sev-${a.sev}${isAlt ? ' alt' : ''}">
    <div class="time">${time}</div>
    <div class="info"><div class="line">${isAlt ? '<span class="alt-tag">Alternatief</span>' : ''}${esc(a.products.join(' + ') || 'Trein')}${a.direction ? ` richting ${esc(a.direction)}` : ''}</div><div class="meta">${meta}</div></div>
    <div class="badge ${a.sev}">${esc(badge)}</div>
    ${msg}
  </li>`;
}

function disruptionRow(d) {
  const meta = [d.duur, d.extra].filter(Boolean).join(' · ');
  return `<div class="disruption${d.type === 'MAINTENANCE' ? ' maintenance' : ''}">
    <strong>${d.type === 'MAINTENANCE' ? 'Werkzaamheden: ' : d.type === 'CALAMITY' ? 'Calamiteit: ' : 'Storing: '}${esc(d.title)}</strong>
    ${d.detail ? `<div>${esc(d.detail)}</div>` : ''}
    ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
  </div>`;
}

/* ---------- meldingen ---------- */
async function maybeNotify(t, analysed, onRoute, altKey) {
  if (!state.settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  const binnenUur = analysed.filter((a) => parseDate(a.aDep) - Date.now() < 60 * 60000);
  const alt = analysed.find((a) => a.key === altKey);
  for (const a of binnenUur) {
    if (a.sev === 'ok') continue;
    const id = `${t.id}|${a.key}|${a.sev}|${a.delay}`;
    if (notified.has(id)) continue;
    notified.add(id);
    const what = a.cancelled ? 'rijdt niet' : a.sev === 'vertraging' ? `+${a.delay} min vertraging` : (STATUS_LABEL[a.status] || 'storing').toLowerCase();
    let body = `Trein van ${hhmm(parseDate(a.pDep))} ${what}.`;
    if (a.msgs[0]) body += ` ${a.msgs[0]}`;
    if (alt) body += `\nAlternatief: ${hhmm(parseDate(alt.aDep))} (${alt.products.join(' + ')}), aankomst ${hhmm(parseDate(alt.aArr))}.`;
    notify(`${t.naam}: ${what}`, body, id);
  }
  for (const d of onRoute) {
    if (d.type === 'MAINTENANCE') continue;
    const id = `${t.id}|dis|${d.id}`;
    if (notified.has(id)) continue;
    notified.add(id);
    notify(`${t.naam}: ${d.title}`, [d.detail, d.duur].filter(Boolean).join('\n'), id);
  }
}
async function notify(title, body, tag) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return reg.showNotification(title, { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
    new Notification(title, { body, tag, icon: 'icons/icon-192.png' });
  } catch { /* meldingen niet beschikbaar */ }
}

/* ---------- TRAJECTEN ---------- */
function renderTrajecten() {
  const el = $('#traject-list');
  if (!state.trajecten.length) {
    el.innerHTML = '<p class="muted">Nog geen trajecten.</p>';
    return;
  }
  el.innerHTML = state.trajecten.map((t) => `
    <div class="titem${t.actief ? '' : ' off'}">
      <div>
        <div class="name">${esc(t.naam)}</div>
        <div class="meta">${esc(t.van.naam)} (${esc(t.van.code)}) → ${esc(t.naar.naam)} (${esc(t.naar.code)}) · ${esc(dagenTekst(t.dagen))} ${esc(t.start)}–${esc(t.eind)} · ≥ ${esc(t.drempel)} min</div>
      </div>
      <div class="actions">
        <button class="btn small" data-act="toggle" data-id="${esc(t.id)}">${t.actief ? 'Pauzeren' : 'Activeren'}</button>
        <button class="btn small" data-act="reverse" data-id="${esc(t.id)}" title="Retourtraject maken">⇄</button>
        <button class="btn small" data-act="edit" data-id="${esc(t.id)}">Bewerken</button>
        <button class="btn small danger-ghost" data-act="delete" data-id="${esc(t.id)}">Verwijderen</button>
      </div>
    </div>`).join('');
}

$('#traject-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const t = state.trajecten.find((x) => x.id === b.dataset.id);
  if (!t) return;
  if (b.dataset.act === 'toggle') { t.actief = !t.actief; saveState(); renderTrajecten(); }
  if (b.dataset.act === 'edit') openForm(t);
  if (b.dataset.act === 'reverse') {
    openForm({ ...t, id: '', naam: `${t.naar.naam} → ${t.van.naam}`, van: t.naar, naar: t.van });
  }
  if (b.dataset.act === 'delete') {
    state.trajecten = state.trajecten.filter((x) => x.id !== t.id);
    saveState(); renderTrajecten();
    toast(`"${t.naam}" verwijderd`);
  }
});

const form = $('#traject-form');
$('#day-boxes').innerHTML = DAG_VOLGORDE.map((d) => `<label class="day"><input type="checkbox" name="dag" value="${d}"><span>${DAGEN[d]}</span></label>`).join('');

function stationLabel(s) { return s?.code ? `${s.naam} (${s.code})` : ''; }
function parseStation(v) {
  const s = String(v).trim();
  const m = s.match(/^(.*)\(([A-Za-z0-9]{1,6})\)\s*$/);
  if (m) return { naam: m[1].trim() || m[2].toUpperCase(), code: m[2].toUpperCase() };
  const known = stationOptions.find((o) => o.naam.toLowerCase() === s.toLowerCase());
  if (known) return known;
  if (/^[A-Za-z]{2,5}$/.test(s)) return { naam: s.toUpperCase(), code: s.toUpperCase() };
  return null;
}

function openForm(t) {
  const isNew = !t || !t.id;
  const v = t || { naam: '', van: null, naar: null, dagen: [1, 2, 3, 4, 5], start: '07:30', eind: '19:00', drempel: 5, actief: true };
  $('#form-title').textContent = isNew ? 'Nieuw traject' : 'Traject bewerken';
  form.id.value = isNew ? '' : v.id;
  form.naam.value = v.naam;
  form.van.value = stationLabel(v.van);
  form.naar.value = stationLabel(v.naar);
  $$('input[name=dag]', form).forEach((c) => { c.checked = v.dagen.includes(Number(c.value)); });
  form.start.value = v.start;
  form.eind.value = v.eind;
  form.drempel.value = v.drempel;
  form.actief.checked = v.actief;
  form.classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  form.naam.focus({ preventScroll: true });
}
$('#btn-new').addEventListener('click', () => openForm(null));
$('#btn-cancel').addEventListener('click', () => form.classList.add('hidden'));

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const van = parseStation(form.van.value);
  const naar = parseStation(form.naar.value);
  if (!van || !naar) { toast('Station niet herkend: kies een suggestie of vul de NS-code in (bijv. TB)'); return; }
  if (van.code === naar.code) { toast('Van en naar zijn hetzelfde station'); return; }
  const dagen = $$('input[name=dag]:checked', form).map((c) => Number(c.value));
  if (!dagen.length) { toast('Kies minstens één dag'); return; }
  if (toMin(form.eind.value) <= toMin(form.start.value)) { toast('"Tot" moet later zijn dan "Vanaf"'); return; }
  const data = {
    naam: form.naam.value.trim() || `${van.naam} → ${naar.naam}`,
    van, naar, dagen,
    start: form.start.value, eind: form.eind.value,
    drempel: Math.max(1, Number(form.drempel.value) || 5),
    actief: form.actief.checked,
  };
  if (form.id.value) {
    Object.assign(state.trajecten.find((x) => x.id === form.id.value), data);
  } else {
    state.trajecten.push({ id: uid(), ...data });
  }
  saveState();
  form.classList.add('hidden');
  renderTrajecten();
  toast('Traject opgeslagen');
});

// stationssuggesties
let stationOptions = [
  { code: 'TB', naam: 'Tilburg' }, { code: 'BD', naam: 'Breda' },
];
function fillDatalist() {
  $('#stations').innerHTML = stationOptions.map((s) => `<option value="${esc(stationLabel(s))}"></option>`).join('');
}
fillDatalist();
let searchT;
['van', 'naar'].forEach((n) => form[n].addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchT);
  if (!state.apiKey || q.length < 2 || /\)$/.test(q)) return;
  searchT = setTimeout(async () => {
    try {
      const res = await searchStations(q);
      const map = new Map([...res, ...stationOptions].map((s) => [s.code, s]));
      stationOptions = [...map.values()].slice(0, 40);
      fillDatalist();
    } catch { /* stil */ }
  }, 300);
}));

// export / import
$('#btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ versie: 1, trajecten: state.trajecten }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ov-trajecten.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#file-import').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const list = Array.isArray(data) ? data : data.trajecten;
    if (!Array.isArray(list) || !list.every((t) => t.van?.code && t.naar?.code && Array.isArray(t.dagen))) throw new Error();
    state.trajecten = list.map((t) => ({ id: t.id || uid(), naam: t.naam || `${t.van.naam} → ${t.naar.naam}`, start: '07:30', eind: '19:00', drempel: 5, actief: true, ...t }));
    saveState(); renderTrajecten();
    toast(`${list.length} traject(en) geïmporteerd`);
  } catch {
    toast('Ongeldig bestand');
  }
  e.target.value = '';
});
$('#btn-reset').addEventListener('click', () => {
  state.trajecten = defaultTrajecten();
  saveState(); renderTrajecten();
  toast('Standaardtrajecten Tilburg ⇄ Breda hersteld');
});

/* ---------- INSTELLINGEN ---------- */
const sform = $('#settings-form');
function fillSettings() {
  sform.apiKey.value = state.apiKey;
  sform.refreshSec.value = String(state.settings.refreshSec);
  sform.aantal.value = String(state.settings.aantal);
  sform.notify.checked = !!state.settings.notify;
  $('#settings-msg').textContent = '';
}
$('#btn-showkey').addEventListener('click', (e) => {
  const show = sform.apiKey.type === 'password';
  sform.apiKey.type = show ? 'text' : 'password';
  e.target.textContent = show ? 'Verberg' : 'Toon';
});
sform.addEventListener('submit', async (e) => {
  e.preventDefault();
  state.apiKey = sform.apiKey.value.trim();
  state.settings.refreshSec = Number(sform.refreshSec.value);
  state.settings.aantal = Number(sform.aantal.value);
  state.settings.notify = sform.notify.checked;
  if (state.settings.notify && 'Notification' in window && Notification.permission === 'default') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') { state.settings.notify = false; sform.notify.checked = false; toast('Meldingen niet toegestaan door de browser'); }
  }
  saveState();
  scheduleRefresh();
  toast('Instellingen opgeslagen');
});
$('#btn-test').addEventListener('click', async () => {
  const msg = $('#settings-msg');
  const prev = state.apiKey;
  state.apiKey = sform.apiKey.value.trim();
  msg.textContent = 'Testen…';
  try {
    const r = await searchStations('Tilburg');
    msg.textContent = r.length ? `✓ Sleutel werkt (gevonden: ${r[0].naam}). Vergeet niet op te slaan.` : '✓ Verbinding werkt, maar geen stations gevonden.';
  } catch (err) {
    msg.textContent = `✗ ${err.message}`;
  } finally {
    state.apiKey = prev;
  }
});

/* ---------- auto-refresh ---------- */
let timer;
function scheduleRefresh() {
  clearInterval(timer);
  const s = Number(state.settings.refreshSec);
  if (s > 0) timer = setInterval(() => {
    if (document.visibilityState === 'visible' && $('#tab-live').classList.contains('active')) refreshLive();
  }, s * 1000);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && $('#tab-live').classList.contains('active')) refreshLive();
});
$('#btn-refresh').addEventListener('click', refreshLive);

/* ---------- start ---------- */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
scheduleRefresh();
showTab(state.apiKey ? 'live' : 'instellingen');
if (!state.apiKey) refreshLive();
