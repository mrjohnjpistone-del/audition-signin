# Audition Sign-In

A shareable audition booking form with a live staff roster. Anyone with the link
can claim an open timeslot from any phone or computer, on any network. Staff open
a key-protected roster from anywhere and watch names and contact info appear in
real time.

- **Public page** `/` — pick a time, enter name + contact, done.
- **Staff page** `/staff` — enter the access key, see every slot with who booked it,
  add slots, export CSV, edit the event, rotate the key.

No database service. No Google Calendar. No `npm install` — it's plain Node.js,
so there's nothing to break on deploy. Sign-ups persist to a JSON file on disk.

---

## Run it on your own computer (optional, to try it first)

```bash
node server.js
```

Then open <http://localhost:3000> (public form) and
<http://localhost:3000/staff> (staff roster). The starting staff key is printed
in the terminal.

---

## Put it online so anyone can use it — Render (free)

You only need to do three things:

1. **Push this folder to a new GitHub repo**, then on <https://render.com> click
   **New → Blueprint** and point it at that repo. Render reads `render.yaml`
   and sets everything up automatically (web service + a 1 GB persistent disk for
   the data).

2. **Set your staff key.** During setup Render will ask for the value of
   `STAFF_KEY` (it's marked "sync: false" so it isn't committed to git). Type any
   secret you want your team to use. *(If you skip it, the app falls back to the
   built-in default key — change it later from the staff page under "Change key".)*

3. **Click Apply / Create.** In ~1 minute you get a public URL like
   `https://audition-signin.onrender.com`.

That's it. Share the **base URL** with auditioners; give your team the same URL
with `/staff` on the end plus the staff key.

> Free Render web services sleep after ~15 min of inactivity and take a few
> seconds to wake on the next visit. Sign-ups are never lost (they're on the
> persistent disk). Upgrade to a paid instance if you want it always-on.

---

## How it works (for the curious)

- `server.js` — a ~250-line Node `http` server, no dependencies.
- Data lives in one JSON file (`auditions.json`) in `DATA_DIR`. Writes are atomic
  (temp file + rename) and serialized, so concurrent sign-ups can't corrupt it.
- Double-booking is impossible: the check-and-claim happens in one synchronous
  step, and Node runs it single-threaded.
- Times are stored as plain local wall-clock strings (`YYYY-MM-DDTHH:MM`) and
  shown exactly as entered — no timezone surprises. Everyone sees the venue's time.
- The public API only ever exposes *availability*, never other people's names or
  contact details. Those are behind the staff key.

## Configuration (environment variables)

| Variable    | Default            | Meaning                                   |
|-------------|--------------------|-------------------------------------------|
| `PORT`      | `3000`             | Port to listen on (Render sets this).     |
| `STAFF_KEY` | built-in default   | Staff access key. Set your own.           |
| `DATA_DIR`  | `./data`           | Folder for the JSON data file.            |
