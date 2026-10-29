# Clinic booking API

An API that lets patients book appointment slots, plus a web page that uses it. Built for Task 1 of the Koya Cohort 4 assessment, following the [spec](https://koyaacademy.com/assessment-api).

- **API:** https://koya-booking-one.vercel.app (every request needs `X-API-Key`)
- **Web page:** https://koya-booking-one.vercel.app/

Stack: TypeScript, [Hono](https://hono.dev), Postgres on [Neon](https://neon.tech), deployed on Vercel (iad1, the same region as the database).

## Endpoints

| Method | Path | Level | What it does |
|---|---|---|---|
| `POST` | `/reset` | 1 | Deletes every booking and replaces all slots |
| `GET` | `/slots?provider=` | 1 | Every slot, earliest first, with `available` |
| `POST` | `/bookings` | 1–5 | Books a slot |
| `GET` | `/bookings/{id}` | 1 | One booking |
| `DELETE` | `/bookings/{id}` | 3 | Cancels a booking and frees the slot |
| `GET` | `/bookings?email=&limit=&cursor=` | 4 | A person's bookings, oldest first, cursor-paged |

Errors are always `{"error": "<message>"}`.

## How each level is handled

**Level 1: slots and bookings.** Slots keep the exact `start`/`end` strings the client sent, so responses echo them unchanged. They also keep parsed timestamps for sorting and the "already started" check.

**Level 2: API key and validation.** Middleware checks `X-API-Key` against the key in the environment, using a constant-time compare, and returns 401 otherwise. `POST /bookings` validates in the order the spec lists the errors: missing or blank fields and bad email (400), unknown slot (404), slot already started (400). Name and email are trimmed, and email is lower-cased before it's stored.

**Level 3: no double booking, even at the same instant.** The database enforces it, not application code:

```sql
CREATE UNIQUE INDEX one_confirmed_booking_per_slot ON bookings (slot_id) WHERE status = 'confirmed';
```

The insert uses `ON CONFLICT ... DO NOTHING`. When two requests race, Postgres makes the second insert wait for the first transaction. If the first commits, the second inserts nothing and the API returns 409. A "check, then insert" in code would let both through. Cancelling sets `status = 'cancelled'`, which takes the row out of the index and frees the slot.

**Level 4: idempotent retries and paging.** An `Idempotency-Key` takes a Postgres advisory lock on that key for the length of the transaction. A retry that arrives while the first attempt is still running waits for it, then replays the stored status code and body from `idempotency_keys`. The booking and its idempotency record commit together, so no crash can separate them. A reused key with a different body (compared as canonical JSON, so key order doesn't matter) returns 422. Error responses are stored too, except 429, so a retry after a rate limit isn't stuck replaying it.

`GET /bookings` pages by an insertion-order sequence (`seq`) with an opaque base64 cursor. Unlike offset paging, a new booking arriving mid-scroll can't shift pages and cause repeats or gaps.

**Level 5: rate limit.** Every attempt counts toward a sliding one-minute window per email, failed ones included. The check runs under an advisory lock on the email, so a burst of simultaneous requests is counted one at a time and exactly 5 get through. The 6th returns 429 with `Retry-After` in whole seconds: the time until the oldest attempt leaves the window. Other emails aren't affected.

**The web page.** The page never sees the API key. It calls `/ui/*`, a small server-side proxy that adds the key and forwards only what a patient needs: list slots, book, view and cancel a booking. It does not forward `/reset` or listing bookings by email. Each booking attempt sends its own `Idempotency-Key`, so a double-click or a retry on a bad connection can't book twice.

## Run it

```bash
cp .env.example .env          # set DATABASE_URL and API_KEY
npm install
npm run db:schema             # create tables
npm run dev                   # http://localhost:3000
npm run seed                  # a week of demo slots (calls /reset)
npm test                      # contract tests for levels 1-5 (calls /reset)
BASE_URL=https://koya-booking-one.vercel.app npm test   # same tests, against the live API
```

## Layout

```
src/app.ts      routes, validation, booking, idempotency, rate limit, /ui proxy
src/db.ts       Postgres pool and transaction helper
src/page.ts     the booking page
schema.sql      tables and the constraints above
tests/          contract tests, one or more per level, including concurrency
scripts/        local dev server and demo seed data
```
