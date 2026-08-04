// ─── Audition Sign-In ────────────────────────────────────────────────────────
// A tiny, zero-dependency Node server. Anyone with the public link can claim an
// open timeslot from any device or network; staff open a key-gated roster from
// anywhere and watch it fill in live. Data persists to a JSON file on disk.
//
// No framework, no database service, nothing to `npm install`. Runs on any Node 18+.
//
//   PUBLIC PAGE   GET  /                     the sign-up form
//   STAFF PAGE    GET  /staff                the roster (asks for the access key)
//
//   PUBLIC API    GET  /api/public           event info + slot availability (no names)
//                 POST /api/signup           claim a slot
//   STAFF API     GET    /api/staff/roster        full roster w/ names + contacts
//                 POST   /api/staff/slots         add slots (range-generate or list)
//                 DELETE /api/staff/slots/:id     remove a slot
//                 DELETE /api/staff/signups/:id   cancel a signup (reopens the slot)
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
    // { id, slot_id, name, email, phone, role, military, military_detail, ensemble,
    //   stage_experience, training, conflict_none, conflict_weekdays[], conflict_dates[],
    //   conflict_notes, crew_interests[], emergency_name, emergency_phone, mailing_list,
    //   notes, created_at }
    signups: [],
  };
}
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    d.settings = Object.assign(freshStore().settings, d.settings || {});
    if (!d.settings.staff_key) d.settings.staff_key = DEFAULT_KEY;
    d.slots = Array.isArray(d.slots) ? d.slots : [];
    d.signups = Array.isArray(d.signups) ? d.signups : [];
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
    if (method === 'GET' && (p === '/staff' || p === '/admin')) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      return sendFile(res, 'staff.html', 'text/html; charset=utf-8');
    }
    if (method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true });

    // ── PUBLIC API ──────────────────────────────────────────────────────────
    if (method === 'GET' && p === '/api/public') {
      const slots = store.slots.slice().sort(byLocal).map((sl) => ({
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
      // ── New audition-registration fields (A–G) ──────────────────────────────
      let ensemble = s(b.ensemble, 10); ensemble = ensemble === 'Yes' ? 'Yes' : ensemble === 'No' ? 'No' : '';
      const stage_experience = s(b.stage_experience, 1200);
      const training = s(b.training, 800);
      const emergency_name = s(b.emergency_name, 120);
      const emergency_phone = s(b.emergency_phone, 40);
      const mailing_list = s(b.mailing_list, 10) === 'Yes' ? 'Yes' : 'No';
      const conflict_none = b.conflict_none === true || b.conflict_none === 'true';
      const WEEKDAYS = /^(Monday|Tuesday|Wednesday|Thursday|Friday)$/;
      const conflict_weekdays = Array.isArray(b.conflict_weekdays)
        ? b.conflict_weekdays.map((x) => s(x, 12)).filter((x) => WEEKDAYS.test(x)).slice(0, 5) : [];
      const conflict_dates = Array.isArray(b.conflict_dates)
        ? [...new Set(b.conflict_dates.map((x) => s(x, 10)).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)))].sort().slice(0, 120) : [];
      const conflict_notes = s(b.conflict_notes, 800);
      const crew_interests = Array.isArray(b.crew_interests)
        ? [...new Set(b.crew_interests.map((x) => s(x, 60)).filter(Boolean))].slice(0, 30) : [];
      if (!name) return sendJson(res, 400, { error: 'Please enter your name.' });
      if (!email && !phone) return sendJson(res, 400, { error: 'Please add an email or phone so staff can reach you.' });
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: 'That email address looks off — please check it.' });
      if (!military) return sendJson(res, 400, { error: 'Please answer the military experience question.' });
      const slot = store.slots.find((x) => x.id === slot_id);
      if (!slot) return sendJson(res, 404, { error: 'That timeslot no longer exists.' });
      // Single-threaded Node: this check-then-insert is atomic (no await between them).
      if (isTaken(slot_id)) return sendJson(res, 409, { error: 'Sorry — someone just claimed that slot. Please pick another.' });
      store.signups.push({ id: uuid(), slot_id, name, email: email || null, phone: phone || null,
        role: role || null, military, military_detail: military_detail || null,
        ensemble: ensemble || null, stage_experience: stage_experience || null, training: training || null,
        conflict_none: !!conflict_none, conflict_weekdays, conflict_dates, conflict_notes: conflict_notes || null,
        crew_interests, emergency_name: emergency_name || null, emergency_phone: emergency_phone || null,
        mailing_list, notes: notes || null, created_at: new Date().toISOString() });
      save();
      return sendJson(res, 200, { ok: true, slot_local: slot.slot_local, duration_min: slot.duration_min });
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
              military: g.military || null, military_detail: g.military_detail || null,
              ensemble: g.ensemble || null, stage_experience: g.stage_experience || null, training: g.training || null,
              conflict_none: !!g.conflict_none, conflict_weekdays: g.conflict_weekdays || [], conflict_dates: g.conflict_dates || [],
              conflict_notes: g.conflict_notes || null, crew_interests: g.crew_interests || [],
              emergency_name: g.emergency_name || null, emergency_phone: g.emergency_phone || null,
              mailing_list: g.mailing_list || null, notes: g.notes, created_at: g.created_at } : null };
        });
        const e = store.settings;
        return sendJson(res, 200, {
          event: { title: e.title, subtitle: e.subtitle, location: e.location, notes: e.notes },
          slots, counts: { total: slots.length, booked: slots.filter((x) => x.signup).length },
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

      if (method === 'DELETE' && p.startsWith('/api/staff/signups/')) {
        const id = decodeURIComponent(p.slice('/api/staff/signups/'.length));
        const before = store.signups.length;
        store.signups = store.signups.filter((g) => g.id !== id);
        save();
        return sendJson(res, 200, { ok: true, deleted: before - store.signups.length });
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
  console.log(`  Staff roster: http://localhost:${PORT}/staff   (key: ${store.settings.staff_key})`);
  console.log(`  Data file   : ${DATA_FILE}`);
});
