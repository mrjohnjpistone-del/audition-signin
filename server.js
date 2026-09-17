// ─── Audition Sign-In ────────────────────────────────────────────────────────
// A tiny, zero-dependency Node server. Anyone with the public link can claim an
// open timeslot from any device or network; staff open a key-gated roster from
// anywhere and watch it fill in live. Data persists to a JSON file on disk.
//
// No framework, no database service, nothing to `npm install`. Runs on any Node 18+.
//
//   PUBLIC PAGE   GET  /                     the sign-up form (book a timeslot)
//   SIGN-IN PAGE  GET  /signin               walk-in sign-in form (used at the audition)
//   STAFF PAGE    GET  /staff                the roster (asks for the access key)
//   MATERIALS     GET  /materials            shared set-build materials list (open to all)
//
//   PUBLIC API    GET  /api/public           event info + slot availability (no names)
//                 POST /api/signup           claim a slot
//                 POST /api/checkin          walk-in audition sign-in (no slot)
//   MATERIALS API GET    /api/materials           the whole list + pick-lists
//                 GET    /api/materials.csv       download the list as a spreadsheet
//                 POST   /api/materials           add an item
//                 PATCH  /api/materials/:id       edit an item (send only what changed)
//                 DELETE /api/materials/:id       remove an item (kept in a small trash)
//                 POST   /api/materials/restore   undo a removal
//   STAFF API     GET    /api/staff/roster        full roster w/ names + contacts + sign-ins
//                 POST   /api/staff/slots         add slots (range-generate or list)
//                 PATCH  /api/staff/slots/:id     edit a slot's date/time/duration
//                 DELETE /api/staff/slots/:id     remove a slot
//                 POST   /api/staff/day/move      move a whole day to a new date
//                 PATCH  /api/staff/signups/:id   edit a booked person's details
//                 DELETE /api/staff/signups/:id   cancel a signup (reopens the slot)
//                 PATCH  /api/staff/checkins/:id  edit a walk-in sign-in (any field)
//                 DELETE /api/staff/checkins/:id  remove a walk-in sign-in
//                 POST   /api/staff/settings      edit event title/location/notes
//                 POST   /api/staff/key           rotate the staff access key

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT        = process.env.PORT || 3000;
const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE   = path.join(DATA_DIR, 'auditions.json');
const PUBLIC_DIR  = path.join(__dirname, 'public');
const DEFAULT_KEY = process.env.STAFF_KEY || 'GRZonptDh8QY';
// The venue's timezone (Morrilton, AR = US Central). Slot times are stored as the
// venue's wall-clock; "today" must be computed in the venue's zone, not the server's
// (Render runs in UTC — a naive new Date() would flip a day early each evening).
const VENUE_TZ    = process.env.VENUE_TZ || 'America/Chicago';

// ── Storage: one JSON file, atomic writes, serialized so writes never interleave ──
// Build back-to-back slots for one day: local wall-clock 'YYYY-MM-DDTHH:MM' strings.
function genSlots(date, startMin, endMin, dur) {
  const out = [];
  for (let cur = startMin; cur + dur <= endMin; cur += dur) {
    const hh = String(Math.floor(cur / 60)).padStart(2, '0');
    const mm = String(cur % 60).padStart(2, '0');
    out.push({ id: crypto.randomUUID(), slot_local: `${date}T${hh}:${mm}`, duration_min: dur });
  }
  return out;
}

// First-run defaults. On a brand-new deploy (empty disk) the app already shows the
// real event — nothing to configure. Everything here is editable from the staff page.
function freshStore() {
  return {
    settings: {
      title: 'A Few Good Men — Auditions',
      subtitle: 'Rialto Community Art Center',
      location: 'Rialto Community Art Center · 215 E. Broadway Street, Morrilton, AR',
      notes: 'Actors are encouraged to prepare a two-minute dramatic monologue, but a prepared monologue is not required. Auditions will also include cold readings from the script.',
      staff_key: DEFAULT_KEY,
    },
    // Tuesday, August 4, 2026 · 6:00–9:00 PM · 10-minute slots (18 total)
    slots: genSlots('2026-08-04', 18 * 60, 21 * 60, 10),
    signups: [], // { id, slot_id, name, email, phone, role, military, military_detail, notes, created_at }
    // Walk-in audition sign-ins (the /signin form). One record per person who auditions.
    // { id, name, email, phone, role, military, military_detail, ensemble, stage_experience,
    //   training, conflict_none, conflict_weekdays[], conflict_dates[], conflict_notes,
    //   crew_interests[], emergency_name, emergency_phone, mailing_list, notes, created_at }
    checkins: [],
    // Build/props materials list (the /materials page). Open to anyone with the link.
    // { id, name, qty, unit, area, category, notes, link, est_cost, status, added_by,
    //   created_at, updated_at }
    materials: seedMaterials(),
    materials_trash: [], // last few deleted items, so an accidental tap is recoverable
  };
}

// ── Materials list ───────────────────────────────────────────────────────────
const MAT_CATEGORIES = ['Lumber', 'Hardware', 'Paint & Finish', 'Tools & Equipment',
  'Props & Dressing', 'Fabric & Soft Goods', 'Electrical', 'Other'];
const MAT_STATUSES = ['Needed', 'Have it', 'Purchased'];
const MAT_UNASSIGNED = 'Unassigned';
// Common set pieces/areas for this show — used as autocomplete suggestions only.
// Anyone can type a new one; the list on screen always includes whatever is in use.
const MAT_AREA_HINTS = ['Jessup\'s desk', 'Judge\'s box', 'Balcony', 'Courtroom', 'Barracks',
  'Kaffee\'s office', 'Platform / deck', 'Stairs', 'Backdrop', 'General structure'];

// The starting list Jay gave us. Only seeds a store that has never had materials.
function seedMaterials() {
  const now = new Date().toISOString();
  const rows = [
    ['Paint sprayer', 1, 'each', 'Tools & Equipment', '', ''],
    ['Paint supplies (rollers, brushes, trays, drop cloths, tape)', 1, 'set', 'Paint & Finish', '', ''],
    ['Paint', 5, 'gallons', 'Paint & Finish', 'Colors TBD', ''],
    ['4x4x10 post', 5, 'each', 'Lumber', '', ''],
    ['4x4x8 post', 2, 'each', 'Lumber', '', ''],
    ['2x4x12 lumber', 12, 'each', 'Lumber', '', ''],
    ['1x4x10 lumber', 10, 'each', 'Lumber', '', ''],
    ['Luan plywood sheet', 10, 'sheets', 'Lumber', '', ''],
    ['Stair stringer — 1.5 in. x 11.25 in. W x 3 ft. L', 4, 'each', 'Lumber', 'Ace item 5037383', 'https://www.acehardware.com/p/5037383'],
    ['Stair stringer — 1.5 in. x 11.25 in. W x 4 ft. L', 2, 'each', 'Lumber', 'Ace item 5037383 (4 ft. length)', 'https://www.acehardware.com/p/5037383'],
    ['Stair tread — 36 in. L x 11.25 in. W x 1.0625 in.', 9, 'each', 'Lumber', '', ''],
    ['3 in. deck screws — hex or torx head', 1, 'box', 'Hardware', '', ''],
    ['8 in. lag bolts', 1, 'box', 'Hardware', '', ''],
    ['Chain — 2 ft.', 2, 'each', 'Hardware', '', ''],
  ];
  return rows.map(([name, qty, unit, category, notes, link]) => ({
    id: crypto.randomUUID(), name, qty, unit, area: MAT_UNASSIGNED, category,
    notes: notes || null, link: link || null, est_cost: null, status: 'Needed',
    added_by: null, created_at: now, updated_at: now,
  }));
}
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    d.settings = Object.assign(freshStore().settings, d.settings || {});
    if (!d.settings.staff_key) d.settings.staff_key = DEFAULT_KEY;
    d.slots = Array.isArray(d.slots) ? d.slots : [];
    d.signups = Array.isArray(d.signups) ? d.signups : [];
    d.checkins = Array.isArray(d.checkins) ? d.checkins : [];
    // Absent (an older data file) → seed the starting build list. Present → leave it alone,
    // even if it is an empty array, so a list someone cleared out doesn't refill itself.
    d.materials = Array.isArray(d.materials) ? d.materials : seedMaterials();
    d.materials_trash = Array.isArray(d.materials_trash) ? d.materials_trash : [];
    return d;
  } catch (e) {
    return freshStore();
  }
}
let store = load();
let writeChain = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(store);
  writeChain = writeChain.then(() => new Promise((res) => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, snapshot);
      fs.renameSync(tmp, DATA_FILE); // atomic replace — a crash mid-write can't corrupt the file
    } catch (e) { console.error('save error:', e.message); }
    res();
  }));
  return writeChain;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const uuid = () => crypto.randomUUID();
function s(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
}
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 65536) { reject(new Error('too large')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const isTaken = (slotId) => store.signups.some((g) => g.slot_id === slotId);
// The current calendar date at the venue, as 'YYYY-MM-DD' (en-CA formats ISO-style).
// A slot is "past" once its date is before this — so today's remaining times still show.
function venueToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: VENUE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const isPastSlot = (slot_local) => slot_local.slice(0, 10) < venueToday();

// ── Signup rate limit: 15 / hour / IP ────────────────────────────────────────
const hits = new Map();
function allowSignup(ip) {
  const now = Date.now(), win = 3600000, max = 15;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  if (arr.length >= max) { hits.set(ip, arr); return false; }
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 20000) for (const [k, v] of hits) if (v.every((t) => now - t > win)) hits.delete(k);
  return true;
}

// ── Check-in rate limit: kiosk-friendly. Many people sign in from ONE network at
// the venue, so this is far more generous than the signup limit — it only exists
// to stop a runaway loop, not to gate a busy sign-in table. 300 / hour / IP.
const checkinHits = new Map();
function allowCheckin(ip) {
  const now = Date.now(), win = 3600000, max = 300;
  const arr = (checkinHits.get(ip) || []).filter((t) => now - t < win);
  if (arr.length >= max) { checkinHits.set(ip, arr); return false; }
  arr.push(now); checkinHits.set(ip, arr);
  if (checkinHits.size > 20000) for (const [k, v] of checkinHits) if (v.every((t) => now - t > win)) checkinHits.delete(k);
  return true;
}

// ── Materials rate limit: a whole build crew may share one wifi, so this is the
// generous kiosk-style limit, not the signup one. 400 writes / hour / IP.
const matHits = new Map();
function allowMaterial(ip) {
  const now = Date.now(), win = 3600000, max = 400;
  const arr = (matHits.get(ip) || []).filter((t) => now - t < win);
  if (arr.length >= max) { matHits.set(ip, arr); return false; }
  arr.push(now); matHits.set(ip, arr);
  if (matHits.size > 20000) for (const [k, v] of matHits) if (v.every((t) => now - t > win)) matHits.delete(k);
  return true;
}

// Read the fields of a materials item off a request body. `base` supplies the
// current values on an edit, so a PATCH can send only what changed.
function readMaterial(b, base) {
  const cur = base || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const out = {};
  out.name = has('name') ? s(b.name, 160) : cur.name;
  out.unit = has('unit') ? s(b.unit, 40) : (cur.unit || '');
  out.area = has('area') ? (s(b.area, 80) || MAT_UNASSIGNED) : (cur.area || MAT_UNASSIGNED);
  out.notes = has('notes') ? (s(b.notes, 800) || null) : (cur.notes || null);
  out.added_by = has('added_by') ? (s(b.added_by, 80) || null) : (cur.added_by || null);

  if (has('category')) {
    const c = s(b.category, 40);
    out.category = MAT_CATEGORIES.includes(c) ? c : 'Other';
  } else out.category = cur.category || 'Other';

  if (has('status')) {
    const st = s(b.status, 20);
    out.status = MAT_STATUSES.includes(st) ? st : 'Needed';
  } else out.status = cur.status || 'Needed';

  if (has('qty')) {
    const n = Number(b.qty);
    out.qty = Number.isFinite(n) && n > 0 ? Math.min(Math.round(n * 100) / 100, 100000) : 1;
  } else out.qty = cur.qty == null ? 1 : cur.qty;

  if (has('est_cost')) {
    const n = Number(b.est_cost);
    out.est_cost = b.est_cost === '' || b.est_cost == null || !Number.isFinite(n) || n < 0
      ? null : Math.min(Math.round(n * 100) / 100, 1000000);
  } else out.est_cost = cur.est_cost == null ? null : cur.est_cost;

  if (has('link')) {
    const raw = s(b.link, 500);
    // Only http(s) links — never javascript:/data: URLs, which the page renders as anchors.
    out.link = /^https?:\/\/\S+$/i.test(raw) ? raw : null;
  } else out.link = cur.link || null;

  return out;
}

// Areas offered as autocomplete: the suggestions plus every area actually in use.
function materialAreas() {
  const seen = new Set(MAT_AREA_HINTS);
  for (const m of store.materials) if (m.area && m.area !== MAT_UNASSIGNED) seen.add(m.area);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function csvCell(v) {
  const t = v == null ? '' : String(v);
  return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

// Normalize a submitted list of strings against an allowed set (checkboxes / multi-select).
function pickList(raw, allowed, maxLen) {
  if (!Array.isArray(raw)) return [];
  const set = allowed ? new Set(allowed) : null;
  const out = [];
  for (const v of raw) {
    const t = s(v, maxLen || 120);
    if (!t) continue;
    if (set && !set.has(t)) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= 40) break;
  }
  return out;
}
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

// ── Static page serving ──────────────────────────────────────────────────────
function sendFile(res, file, type) {
  fs.readFile(path.join(PUBLIC_DIR, file), (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

// ── Router ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Security headers on everything. CSP is same-origin only + inline (pages are self-contained).
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;

  try {
    // Pages
    if (method === 'GET' && p === '/') return sendFile(res, 'public.html', 'text/html; charset=utf-8');
    if (method === 'GET' && p === '/signin') return sendFile(res, 'signin.html', 'text/html; charset=utf-8');
    if (method === 'GET' && (p === '/staff' || p === '/admin')) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      return sendFile(res, 'staff.html', 'text/html; charset=utf-8');
    }
    if (method === 'GET' && (p === '/materials' || p === '/build')) {
      return sendFile(res, 'materials.html', 'text/html; charset=utf-8');
    }
    if (method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true });

    // ── PUBLIC API ──────────────────────────────────────────────────────────
    if (method === 'GET' && p === '/api/public') {
      // Only upcoming times are offered publicly. Past audition dates are hidden so
      // no one can book a date that has already happened. (Staff still see everything.)
      const slots = store.slots.slice()
        .filter((sl) => !isPastSlot(sl.slot_local))
        .sort(byLocal).map((sl) => ({
          id: sl.id, slot_local: sl.slot_local, duration_min: sl.duration_min, taken: isTaken(sl.id),
        }));
      const e = store.settings;
      return sendJson(res, 200, {
        event: { title: e.title, subtitle: e.subtitle, location: e.location, notes: e.notes },
        slots,
      });
    }

    if (method === 'POST' && p === '/api/signup') {
      if (!allowSignup(clientIp(req)))
        return sendJson(res, 429, { error: 'Too many sign-ups from this network. Please try again later.' });
      const b = await readBody(req);
      const slot_id = s(b.slot_id, 60), name = s(b.name, 120), email = s(b.email, 160),
            phone = s(b.phone, 40), role = s(b.role, 160), notes = s(b.notes, 800);
      let military = s(b.military, 10); military = military === 'Yes' ? 'Yes' : military === 'No' ? 'No' : '';
      const military_detail = military === 'Yes' ? s(b.military_detail, 800) : '';
      if (!name) return sendJson(res, 400, { error: 'Please enter your name.' });
      if (!email && !phone) return sendJson(res, 400, { error: 'Please add an email or phone so staff can reach you.' });
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: 'That email address looks off — please check it.' });
      if (!military) return sendJson(res, 400, { error: 'Please answer the military experience question.' });
      const slot = store.slots.find((x) => x.id === slot_id);
      if (!slot) return sendJson(res, 404, { error: 'That timeslot no longer exists.' });
      if (isPastSlot(slot.slot_local))
        return sendJson(res, 409, { error: 'That audition date has already passed. Please pick an upcoming time.' });
      // Single-threaded Node: this check-then-insert is atomic (no await between them).
      if (isTaken(slot_id)) return sendJson(res, 409, { error: 'Sorry — someone just claimed that slot. Please pick another.' });
      store.signups.push({ id: uuid(), slot_id, name, email: email || null, phone: phone || null,
        role: role || null, military, military_detail: military_detail || null,
        notes: notes || null, created_at: new Date().toISOString() });
      save();
      return sendJson(res, 200, { ok: true, slot_local: slot.slot_local, duration_min: slot.duration_min });
    }

    // Walk-in audition sign-in. No slot — one record per person who shows up to audition.
    if (method === 'POST' && p === '/api/checkin') {
      if (!allowCheckin(clientIp(req)))
        return sendJson(res, 429, { error: 'Too many sign-ins from this network right now. Please wait a moment and try again.' });
      const b = await readBody(req);
      const name = s(b.name, 120), email = s(b.email, 160), phone = s(b.phone, 40),
            role = s(b.role, 160), notes = s(b.notes, 800);
      let military = s(b.military, 10); military = military === 'Yes' ? 'Yes' : military === 'No' ? 'No' : '';
      const military_detail = military === 'Yes' ? s(b.military_detail, 800) : '';
      let ensemble = s(b.ensemble, 20);
      ensemble = ['Yes', 'No', 'Only role'].includes(ensemble) ? ensemble : '';
      const stage_experience = s(b.stage_experience, 1500);
      const training = s(b.training, 1500);
      const conflict_none = b.conflict_none === true || b.conflict_none === 'true';
      const conflict_weekdays = conflict_none ? [] : pickList(b.conflict_weekdays, WEEKDAYS, 12);
      const conflict_dates = conflict_none ? [] : pickList(b.conflict_dates, null, 10)
        .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
      const conflict_notes = conflict_none ? '' : s(b.conflict_notes, 800);
      const crew_interests = pickList(b.crew_interests, null, 60);
      const emergency_name = s(b.emergency_name, 120);
      const emergency_phone = s(b.emergency_phone, 40);
      const mailing_list = b.mailing_list === true || b.mailing_list === 'true';

      if (!name) return sendJson(res, 400, { error: 'Please enter your name.' });
      if (!email && !phone) return sendJson(res, 400, { error: 'Please add an email or phone so staff can reach you.' });
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: 'That email address looks off — please check it.' });
      if (!military) return sendJson(res, 400, { error: 'Please answer the military experience question.' });

      store.checkins.push({
        id: uuid(), name, email: email || null, phone: phone || null, role: role || null,
        military, military_detail: military_detail || null,
        ensemble: ensemble || null, stage_experience: stage_experience || null, training: training || null,
        conflict_none, conflict_weekdays, conflict_dates, conflict_notes: conflict_notes || null,
        crew_interests, emergency_name: emergency_name || null, emergency_phone: emergency_phone || null,
        mailing_list, notes: notes || null, created_at: new Date().toISOString(),
      });
      save();
      return sendJson(res, 200, { ok: true, name });
    }

    // ── MATERIALS API (open — anyone with the link can read and add) ────────
    if (method === 'GET' && p === '/api/materials') {
      return sendJson(res, 200, {
        items: store.materials,
        categories: MAT_CATEGORIES,
        statuses: MAT_STATUSES,
        areas: materialAreas(),
        show: store.settings.title.replace(/\s*—.*$/, ''),
      });
    }

    if (method === 'GET' && p === '/api/materials.csv') {
      const cols = ['Item', 'Qty', 'Unit', 'For', 'Category', 'Status', 'Est. cost', 'Link', 'Notes', 'Added by', 'Added'];
      const lines = [cols.join(',')];
      for (const m of store.materials) {
        lines.push([m.name, m.qty, m.unit, m.area, m.category, m.status,
          m.est_cost == null ? '' : m.est_cost, m.link, m.notes, m.added_by,
          (m.created_at || '').slice(0, 10)].map(csvCell).join(','));
      }
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="materials-list.csv"',
        'Cache-Control': 'no-store',
      });
      return res.end(lines.join('\n'));
    }

    if (method === 'POST' && p === '/api/materials') {
      if (!allowMaterial(clientIp(req)))
        return sendJson(res, 429, { error: 'Too many changes from this network right now. Please wait a moment.' });
      if (store.materials.length >= 2000)
        return sendJson(res, 409, { error: 'This list is full (2,000 items). Remove something before adding more.' });
      const f = readMaterial(await readBody(req), null);
      if (!f.name) return sendJson(res, 400, { error: 'Please name the item.' });
      const now = new Date().toISOString();
      const item = Object.assign({ id: uuid() }, f, { created_at: now, updated_at: now });
      store.materials.push(item);
      save();
      return sendJson(res, 200, { ok: true, item });
    }

    if (method === 'PATCH' && p.startsWith('/api/materials/')) {
      if (!allowMaterial(clientIp(req)))
        return sendJson(res, 429, { error: 'Too many changes from this network right now. Please wait a moment.' });
      const id = decodeURIComponent(p.slice('/api/materials/'.length));
      const item = store.materials.find((m) => m.id === id);
      if (!item) return sendJson(res, 404, { error: 'That item is no longer on the list.' });
      const f = readMaterial(await readBody(req), item);
      if (!f.name) return sendJson(res, 400, { error: 'Please name the item.' });
      Object.assign(item, f, { updated_at: new Date().toISOString() });
      save();
      return sendJson(res, 200, { ok: true, item });
    }

    if (method === 'DELETE' && p.startsWith('/api/materials/')) {
      if (!allowMaterial(clientIp(req)))
        return sendJson(res, 429, { error: 'Too many changes from this network right now. Please wait a moment.' });
      const id = decodeURIComponent(p.slice('/api/materials/'.length));
      const i = store.materials.findIndex((m) => m.id === id);
      if (i === -1) return sendJson(res, 404, { error: 'That item is no longer on the list.' });
      const [gone] = store.materials.splice(i, 1);
      // Keep the last 25 removals so an accidental tap on a phone can be undone.
      store.materials_trash.unshift(gone);
      store.materials_trash = store.materials_trash.slice(0, 25);
      save();
      return sendJson(res, 200, { ok: true, id });
    }

    if (method === 'POST' && p === '/api/materials/restore') {
      const b = await readBody(req);
      const id = s(b.id, 60);
      const i = store.materials_trash.findIndex((m) => m.id === id);
      if (i === -1) return sendJson(res, 404, { error: 'Nothing left to undo for that item.' });
      const [back] = store.materials_trash.splice(i, 1);
      back.updated_at = new Date().toISOString();
      store.materials.push(back);
      save();
      return sendJson(res, 200, { ok: true, item: back });
    }

    // ── STAFF API (all require the key) ─────────────────────────────────────
    if (p.startsWith('/api/staff')) {
      const provided = req.headers['x-staff-key'] || url.searchParams.get('key') || '';
      if (!provided || provided !== store.settings.staff_key)
        return sendJson(res, 401, { error: 'Invalid staff key.' });

      if (method === 'GET' && p === '/api/staff/roster') {
        const slots = store.slots.slice().sort(byLocal).map((sl) => {
          const g = store.signups.find((x) => x.slot_id === sl.id);
          return { id: sl.id, slot_local: sl.slot_local, duration_min: sl.duration_min,
            signup: g ? { id: g.id, name: g.name, email: g.email, phone: g.phone, role: g.role,
              military: g.military || null, military_detail: g.military_detail || null, notes: g.notes, created_at: g.created_at } : null };
        });
        const checkins = store.checkins.slice()
          .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)) // newest first
          .map((c) => ({
            id: c.id, name: c.name, email: c.email, phone: c.phone, role: c.role,
            military: c.military || null, military_detail: c.military_detail || null,
            ensemble: c.ensemble || null, stage_experience: c.stage_experience || null, training: c.training || null,
            conflict_none: !!c.conflict_none, conflict_weekdays: c.conflict_weekdays || [],
            conflict_dates: c.conflict_dates || [], conflict_notes: c.conflict_notes || null,
            crew_interests: c.crew_interests || [], emergency_name: c.emergency_name || null,
            emergency_phone: c.emergency_phone || null, mailing_list: !!c.mailing_list,
            notes: c.notes || null, created_at: c.created_at,
          }));
        const e = store.settings;
        return sendJson(res, 200, {
          event: { title: e.title, subtitle: e.subtitle, location: e.location, notes: e.notes },
          slots, checkins,
          counts: { total: slots.length, booked: slots.filter((x) => x.signup).length, checkins: checkins.length },
        });
      }

      if (method === 'POST' && p === '/api/staff/slots') {
        const b = await readBody(req);
        const dur = Math.min(240, Math.max(1, parseInt(b.duration_min, 10) || 10));
        let locals = [];
        if (Array.isArray(b.slots)) {
          locals = b.slots.map((x) => s(x, 16)).filter((x) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(x));
        } else if (b.date && b.start && b.end) {
          const date = s(b.date, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Bad date format.' });
          const [sh, sm] = String(b.start).split(':').map(Number);
          const [eh, em] = String(b.end).split(':').map(Number);
          if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return sendJson(res, 400, { error: 'Bad start/end time.' });
          let cur = sh * 60 + sm; const end = eh * 60 + em;
          if (end <= cur) return sendJson(res, 400, { error: 'End time must be after start time.' });
          let guard = 0;
          while (cur + dur <= end && guard++ < 500) {
            locals.push(`${date}T${String(Math.floor(cur / 60)).padStart(2, '0')}:${String(cur % 60).padStart(2, '0')}`);
            cur += dur;
          }
        } else {
          return sendJson(res, 400, { error: 'Provide either a date range or an explicit slots list.' });
        }
        if (!locals.length) return sendJson(res, 400, { error: 'No valid slots to add.' });
        const existing = new Set(store.slots.map((x) => x.slot_local));
        let created = 0;
        for (const loc of locals) {
          if (existing.has(loc)) continue;
          store.slots.push({ id: uuid(), slot_local: loc, duration_min: dur });
          existing.add(loc); created++;
        }
        save();
        return sendJson(res, 200, { ok: true, created, requested: locals.length, skipped: locals.length - created });
      }

      if (method === 'DELETE' && p.startsWith('/api/staff/slots/')) {
        const id = decodeURIComponent(p.slice('/api/staff/slots/'.length));
        const before = store.slots.length;
        store.slots = store.slots.filter((x) => x.id !== id);
        store.signups = store.signups.filter((g) => g.slot_id !== id); // cascade
        save();
        return sendJson(res, 200, { ok: true, deleted: before - store.slots.length });
      }

      // Edit one slot's date/time and/or duration. Keeps any booking attached.
      if (method === 'PATCH' && p.startsWith('/api/staff/slots/')) {
        const id = decodeURIComponent(p.slice('/api/staff/slots/'.length));
        const slot = store.slots.find((x) => x.id === id);
        if (!slot) return sendJson(res, 404, { error: 'That timeslot no longer exists.' });
        const b = await readBody(req);
        if (b.slot_local !== undefined) {
          const loc = s(b.slot_local, 16);
          if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(loc)) return sendJson(res, 400, { error: 'Bad date/time format.' });
          if (store.slots.some((x) => x.id !== id && x.slot_local === loc))
            return sendJson(res, 409, { error: 'Another slot is already at that exact date and time.' });
          slot.slot_local = loc;
        }
        if (b.duration_min !== undefined)
          slot.duration_min = Math.min(240, Math.max(1, parseInt(b.duration_min, 10) || slot.duration_min));
        save();
        return sendJson(res, 200, { ok: true, slot: { id: slot.id, slot_local: slot.slot_local, duration_min: slot.duration_min } });
      }

      // Move a whole day: shift every slot on `from` to `to`, keeping times, durations, and bookings.
      if (method === 'POST' && p === '/api/staff/day/move') {
        const b = await readBody(req);
        const from = s(b.from, 10), to = s(b.to, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
          return sendJson(res, 400, { error: 'Bad date format.' });
        if (from === to) return sendJson(res, 400, { error: 'Pick a different date to move the day to.' });
        const moving = store.slots.filter((x) => x.slot_local.slice(0, 10) === from);
        if (!moving.length) return sendJson(res, 404, { error: 'There are no slots on that day.' });
        const otherTimes = new Set(store.slots.filter((x) => x.slot_local.slice(0, 10) !== from).map((x) => x.slot_local));
        for (const sl of moving) {
          if (otherTimes.has(to + sl.slot_local.slice(10)))
            return sendJson(res, 409, { error: `The target date already has a slot at ${sl.slot_local.slice(11)}. Pick a date with no slots yet, or move that slot first.` });
        }
        for (const sl of moving) sl.slot_local = to + sl.slot_local.slice(10);
        save();
        return sendJson(res, 200, { ok: true, moved: moving.length });
      }

      if (method === 'DELETE' && p.startsWith('/api/staff/signups/')) {
        const id = decodeURIComponent(p.slice('/api/staff/signups/'.length));
        const before = store.signups.length;
        store.signups = store.signups.filter((g) => g.id !== id);
        save();
        return sendJson(res, 200, { ok: true, deleted: before - store.signups.length });
      }

      // Edit a booked person's details (name/contact/role/military/notes).
      if (method === 'PATCH' && p.startsWith('/api/staff/signups/')) {
        const id = decodeURIComponent(p.slice('/api/staff/signups/'.length));
        const g = store.signups.find((x) => x.id === id);
        if (!g) return sendJson(res, 404, { error: 'That sign-up no longer exists.' });
        const b = await readBody(req);
        const pick = (k, max, cur) => (b[k] !== undefined ? s(b[k], max) : (cur || ''));
        const name = pick('name', 120, g.name);
        const email = pick('email', 160, g.email);
        const phone = pick('phone', 40, g.phone);
        const role = pick('role', 160, g.role);
        const notes = pick('notes', 800, g.notes);
        let military = b.military !== undefined ? s(b.military, 10) : g.military;
        military = military === 'Yes' ? 'Yes' : military === 'No' ? 'No' : '';
        const military_detail = military === 'Yes' ? pick('military_detail', 800, g.military_detail) : '';
        if (!name) return sendJson(res, 400, { error: 'Please enter a name.' });
        if (!email && !phone) return sendJson(res, 400, { error: 'Please add an email or phone.' });
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: 'That email address looks off — please check it.' });
        if (!military) return sendJson(res, 400, { error: 'Please answer the military experience question.' });
        Object.assign(g, { name, email: email || null, phone: phone || null, role: role || null,
          military, military_detail: military_detail || null, notes: notes || null });
        save();
        return sendJson(res, 200, { ok: true });
      }

      if (method === 'DELETE' && p.startsWith('/api/staff/checkins/')) {
        const id = decodeURIComponent(p.slice('/api/staff/checkins/'.length));
        const before = store.checkins.length;
        store.checkins = store.checkins.filter((c) => c.id !== id);
        save();
        return sendJson(res, 200, { ok: true, deleted: before - store.checkins.length });
      }

      // Edit a walk-in sign-in — any field on the card. Only fields present in the
      // body are changed; the rest keep their current value.
      if (method === 'PATCH' && p.startsWith('/api/staff/checkins/')) {
        const id = decodeURIComponent(p.slice('/api/staff/checkins/'.length));
        const c = store.checkins.find((x) => x.id === id);
        if (!c) return sendJson(res, 404, { error: 'That sign-in no longer exists.' });
        const b = await readBody(req);
        const pick = (k, max, cur) => (b[k] !== undefined ? s(b[k], max) : (cur || ''));
        const name = pick('name', 120, c.name);
        const email = pick('email', 160, c.email);
        const phone = pick('phone', 40, c.phone);
        const role = pick('role', 160, c.role);
        const notes = pick('notes', 800, c.notes);
        let military = b.military !== undefined ? s(b.military, 10) : c.military;
        military = military === 'Yes' ? 'Yes' : military === 'No' ? 'No' : '';
        const military_detail = military === 'Yes' ? pick('military_detail', 800, c.military_detail) : '';
        let ensemble = b.ensemble !== undefined ? s(b.ensemble, 20) : c.ensemble;
        ensemble = ['Yes', 'No', 'Only role'].includes(ensemble) ? ensemble : '';
        const stage_experience = pick('stage_experience', 1500, c.stage_experience);
        const training = pick('training', 1500, c.training);
        const conflict_none = b.conflict_none !== undefined ? (b.conflict_none === true || b.conflict_none === 'true') : !!c.conflict_none;
        const conflict_weekdays = conflict_none ? []
          : (b.conflict_weekdays !== undefined ? pickList(b.conflict_weekdays, WEEKDAYS, 12) : (c.conflict_weekdays || []));
        const conflict_dates = conflict_none ? []
          : (b.conflict_dates !== undefined ? pickList(b.conflict_dates, null, 10).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)) : (c.conflict_dates || []));
        const conflict_notes = conflict_none ? '' : pick('conflict_notes', 800, c.conflict_notes);
        const crew_interests = b.crew_interests !== undefined ? pickList(b.crew_interests, null, 60) : (c.crew_interests || []);
        const emergency_name = pick('emergency_name', 120, c.emergency_name);
        const emergency_phone = pick('emergency_phone', 40, c.emergency_phone);
        const mailing_list = b.mailing_list !== undefined ? (b.mailing_list === true || b.mailing_list === 'true') : !!c.mailing_list;
        if (!name) return sendJson(res, 400, { error: 'Please enter a name.' });
        if (!email && !phone) return sendJson(res, 400, { error: 'Please add an email or phone.' });
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: 'That email address looks off — please check it.' });
        if (!military) return sendJson(res, 400, { error: 'Please answer the military experience question.' });
        Object.assign(c, {
          name, email: email || null, phone: phone || null, role: role || null,
          military, military_detail: military_detail || null,
          ensemble: ensemble || null, stage_experience: stage_experience || null, training: training || null,
          conflict_none, conflict_weekdays, conflict_dates, conflict_notes: conflict_notes || null,
          crew_interests, emergency_name: emergency_name || null, emergency_phone: emergency_phone || null,
          mailing_list, notes: notes || null,
        });
        save();
        return sendJson(res, 200, { ok: true });
      }

      if (method === 'POST' && p === '/api/staff/settings') {
        const b = await readBody(req);
        store.settings.title = s(b.title, 160) || 'Auditions';
        store.settings.subtitle = s(b.subtitle, 200);
        store.settings.location = s(b.location, 300);
        store.settings.notes = s(b.notes, 1000);
        save();
        return sendJson(res, 200, { ok: true });
      }

      if (method === 'POST' && p === '/api/staff/key') {
        const b = await readBody(req);
        const nk = s(b.new_key, 80);
        if (nk.length < 6) return sendJson(res, 400, { error: 'New key must be at least 6 characters.' });
        store.settings.staff_key = nk;
        save();
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { error: 'Unknown staff endpoint.' });
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found.' });
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    if (err && err.message === 'too large') return sendJson(res, 413, { error: 'Request too large.' });
    console.error('Request error:', err && err.message);
    return sendJson(res, 500, { error: 'Server error. Please try again.' });
  }
});

function byLocal(a, b) { return a.slot_local < b.slot_local ? -1 : a.slot_local > b.slot_local ? 1 : 0; }

server.listen(PORT, () => {
  console.log(`Audition Sign-In running on http://localhost:${PORT}`);
  console.log(`  Public form : http://localhost:${PORT}/`);
  console.log(`  Sign-in form: http://localhost:${PORT}/signin`);
  console.log(`  Staff roster: http://localhost:${PORT}/staff   (key: ${store.settings.staff_key})`);
  console.log(`  Data file   : ${DATA_FILE}`);
});
