# QR Attendance
Node/Express + PostgreSQL + vanilla JS frontend (served by Express).
## Run
1. `npm install`
2. `cp .env.example .env` and fill in values (long random JWT_SECRET / QR_SECRET; ADMIN_EMAIL/ADMIN_PASSWORD seed the first admin)
3. `createdb attendance && npm run migrate`
4. `npm start` → participants: `/`, staff: `/admin`
## Deploy
Any Node host with Postgres (Render, Railway, Fly). Set the env vars, `PGSSL=1` for hosted DBs, `NODE_ENV=production`, run `npm run migrate` once. Camera scanning requires HTTPS.
## How it works
- Import Excel/CSV (headers auto-detected: Name/Full Name, Email/Email ID, Phone/Mobile). Merge updates by email; Replace wipes the list (confirmed).
- QR contains `id.version.HMAC` — no email/phone; unforgeable without QR_SECRET. "Revoke" bumps version (`POST /api/admin/participants/:id/revoke-qr`).
- `UNIQUE(participant_id,event_id)` + `ON CONFLICT DO NOTHING` makes simultaneous duplicate scans impossible.
## Test checklist
Registered email → QR; unknown email → 404; scan → success; rescan → "Already Present"; garbage QR → invalid; `/api/events` without login → 401; closed event rejects scans; import with bad rows → summary; export opens in Excel; scan with network off → "Connection lost".
## Vercel
Needs a hosted Postgres (Neon/Supabase). Run `DATABASE_URL="<hosted url>" npm run migrate` once, then deploy and set env vars DATABASE_URL, JWT_SECRET, QR_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD. Participants: `/`, admin: `/admin`.
