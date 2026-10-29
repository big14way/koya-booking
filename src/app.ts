import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { pool, withTx, type Tx } from "./db.js";
import { PAGE_HTML } from "./page.js";

const API_KEY = process.env.API_KEY ?? "";
const RATE_LIMIT = 5; // booking attempts per email...
const RATE_WINDOW_SECONDS = 60; // ...per sliding minute
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Result = {
  status: ContentfulStatusCode;
  body: unknown;
  headers?: Record<string, string>;
  rollback?: boolean;
};

const fail = (status: ContentfulStatusCode, error: string): Result => ({ status, body: { error } });

function send(c: Context, result: Result) {
  for (const [name, value] of Object.entries(result.headers ?? {})) c.header(name, value);
  return c.json(result.body, result.status);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function toBooking(row: any) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

// Stable JSON (sorted keys), so {"a":1,"b":2} and {"b":2,"a":1} count as the same body.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function keyMatches(given: string | undefined) {
  if (!API_KEY || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "X-API-Key", "Idempotency-Key"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    exposeHeaders: ["Retry-After"],
  }),
);

// Level 2: every API request needs the key. The web page and its /ui proxy are public;
// the proxy adds the key server-side so it never reaches the browser.
app.use("*", async (c, next) => {
  const path = c.req.path;
  if (path === "/" || path.startsWith("/ui/")) return next();
  if (!keyMatches(c.req.header("x-api-key"))) return c.json({ error: "missing or invalid API key" }, 401);
  await next();
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal server error" }, 500);
});

app.notFound((c) => c.json({ error: "not found" }, 404));

// ---------------------------------------------------------------- Level 1: slots

app.post("/reset", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!isObject(body) || !Array.isArray(body.slots)) return send(c, fail(400, 'body must be {"slots": [...]}'));

  const ids = new Set<string>();
  const rows: string[][] = [];
  for (const s of body.slots) {
    const ok =
      isObject(s) &&
      typeof s.id === "string" && s.id.trim() !== "" &&
      typeof s.provider === "string" && s.provider.trim() !== "" &&
      typeof s.start === "string" && !Number.isNaN(Date.parse(s.start)) &&
      typeof s.end === "string" && !Number.isNaN(Date.parse(s.end));
    if (!ok) return send(c, fail(400, "each slot needs id, provider, start and end (ISO date-times)"));
    if (ids.has(s.id as string)) return send(c, fail(400, `duplicate slot id: ${s.id}`));
    ids.add(s.id as string);
    const { id, provider, start, end } = s as Record<string, string>;
    rows.push([id, provider, new Date(start).toISOString(), new Date(end).toISOString(), start, end]);
  }

  await withTx(async (tx) => {
    // Bookings, idempotency records and rate-limit history all belong to the old slots.
    await tx.query("TRUNCATE bookings, slots, idempotency_keys, booking_attempts RESTART IDENTITY");
    if (rows.length > 0) {
      const columns = [0, 1, 2, 3, 4, 5].map((i) => rows.map((r) => r[i]));
      await tx.query(
        `INSERT INTO slots (id, provider, start_at, end_at, start_raw, end_raw)
         SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[], $5::text[], $6::text[])`,
        columns,
      );
    }
    return {};
  });

  return c.json({ ok: true, slots: rows.length }, 200);
});

app.get("/slots", async (c) => {
  const provider = c.req.query("provider") ?? null;
  const { rows } = await pool.query(
    `SELECT s.id, s.provider, s.start_raw, s.end_raw,
            NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
       FROM slots s
      WHERE $1::text IS NULL OR s.provider = $1
      ORDER BY s.start_at, s.id`,
    [provider],
  );
  return c.json({
    slots: rows.map((r) => ({ id: r.id, provider: r.provider, start: r.start_raw, end: r.end_raw, available: r.available })),
  });
});

// ---------------------------------------------------------------- Levels 1–5: booking

app.post("/bookings", async (c) => {
  const raw = await c.req.text();
  let body: unknown;
  let parsed = true;
  try {
    body = JSON.parse(raw);
  } catch {
    parsed = false;
  }
  const idempotencyKey = c.req.header("idempotency-key")?.trim() || null;
  const requestHash = sha256(parsed ? canonical(body) : raw);

  const result = await withTx((tx) => createBooking(tx, { body, parsed, idempotencyKey, requestHash }));
  return send(c, result);
});

async function createBooking(
  tx: Tx,
  req: { body: unknown; parsed: boolean; idempotencyKey: string | null; requestHash: string },
): Promise<Result> {
  // Level 4: requests sharing a key queue on this lock, so a retry that arrives while the
  // first attempt is still running waits for it and then replays its response.
  if (req.idempotencyKey) {
    await tx.query("SELECT pg_advisory_xact_lock(1, hashtext($1))", [req.idempotencyKey]);
    const { rows } = await tx.query(
      "SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1",
      [req.idempotencyKey],
    );
    if (rows[0]) {
      if (rows[0].request_hash !== req.requestHash) {
        return fail(422, "Idempotency-Key was already used with a different request body");
      }
      return { status: rows[0].status_code, body: rows[0].response };
    }
  }

  // Level 5: count every attempt (failed ones too) per email before validating anything else.
  const body = req.body;
  const email = isObject(body) && typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email) {
    const retryAfter = await rateLimit(tx, email);
    if (retryAfter !== null) {
      // Roll back so a 429 is never stored as the idempotent response; the client may retry later.
      return {
        ...fail(429, "too many booking attempts for this email, try again later"),
        headers: { "Retry-After": String(retryAfter) },
        rollback: true,
      };
    }
  }

  const result = await book(tx, req.parsed, body);

  if (req.idempotencyKey) {
    await tx.query(
      "INSERT INTO idempotency_keys (key, request_hash, status_code, response) VALUES ($1, $2, $3, $4)",
      [req.idempotencyKey, req.requestHash, result.status, JSON.stringify(result.body)],
    );
  }
  return result;
}

/** Records an attempt and returns null, or returns the seconds to wait if the email is over the limit. */
async function rateLimit(tx: Tx, email: string): Promise<number | null> {
  // One lock per email, so simultaneous attempts are counted one at a time.
  await tx.query("SELECT pg_advisory_xact_lock(2, hashtext($1))", [email]);
  await tx.query(
    "DELETE FROM booking_attempts WHERE email = $1 AND at <= clock_timestamp() - make_interval(secs => $2)",
    [email, RATE_WINDOW_SECONDS],
  );
  const { rows } = await tx.query(
    `SELECT count(*)::int AS attempts,
            ceil(extract(epoch FROM min(at) + make_interval(secs => $2) - clock_timestamp()))::int AS retry_after
       FROM booking_attempts WHERE email = $1`,
    [email, RATE_WINDOW_SECONDS],
  );
  if (rows[0].attempts >= RATE_LIMIT) return Math.max(1, rows[0].retry_after);
  await tx.query("INSERT INTO booking_attempts (email) VALUES ($1)", [email]);
  return null;
}

async function book(tx: Tx, parsed: boolean, body: unknown): Promise<Result> {
  // Level 2: validation, in the order the spec lists the errors.
  if (!parsed || !isObject(body)) return fail(400, "request body must be a JSON object");
  const slotId = typeof body.slot_id === "string" ? body.slot_id : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!slotId.trim()) return fail(400, "slot_id is required");
  if (!name) return fail(400, "name is required");
  if (!email) return fail(400, "email is required");
  if (!EMAIL_RE.test(email)) return fail(400, "email is not valid");

  const slot = await tx.query("SELECT start_at <= clock_timestamp() AS started FROM slots WHERE id = $1", [slotId]);
  if (slot.rowCount === 0) return fail(404, "slot not found");
  if (slot.rows[0].started) return fail(400, "slot has already started");

  // Level 3: the partial unique index decides. If another request is booking the same slot
  // right now, this insert waits for it, then does nothing if that booking was confirmed.
  const { rows } = await tx.query(
    `INSERT INTO bookings (id, slot_id, name, email, status)
     VALUES ($1, $2, $3, $4, 'confirmed')
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING id, slot_id, name, email, status, created_at`,
    [`bk_${randomUUID()}`, slotId, name, email],
  );
  if (rows.length === 0) return fail(409, "slot is already booked");
  return { status: 201, body: toBooking(rows[0]) };
}

// ---------------------------------------------------------------- Level 4: a person's bookings

const encodeCursor = (seq: string) => Buffer.from(`seq:${seq}`).toString("base64url");
function decodeCursor(cursor: string): string | null {
  const m = /^seq:(\d{1,18})$/.exec(Buffer.from(cursor, "base64url").toString());
  return m ? m[1] : null;
}

app.get("/bookings", async (c) => {
  const email = (c.req.query("email") ?? "").trim().toLowerCase();
  if (!email) return send(c, fail(400, "email is required"));

  const limitParam = c.req.query("limit");
  const limit = limitParam === undefined ? 10 : /^\d+$/.test(limitParam) ? Number(limitParam) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return send(c, fail(400, "limit must be a whole number from 1 to 50"));
  }

  const cursorParam = c.req.query("cursor");
  const after = cursorParam ? decodeCursor(cursorParam) : null;
  if (cursorParam && after === null) return send(c, fail(400, "invalid cursor"));

  const { rows } = await pool.query(
    `SELECT seq, id, slot_id, name, email, status, created_at FROM bookings
      WHERE email = $1 AND ($2::bigint IS NULL OR seq > $2)
      ORDER BY seq LIMIT $3`,
    [email, after, limit + 1],
  );
  const page = rows.slice(0, limit);
  return c.json({
    bookings: page.map(toBooking),
    next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1].seq) : null,
  });
});

// ---------------------------------------------------------------- Levels 1 and 3: one booking

app.get("/bookings/:id", async (c) => {
  const { rows } = await pool.query(
    "SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = $1",
    [c.req.param("id")],
  );
  if (rows.length === 0) return send(c, fail(404, "booking not found"));
  return c.json(toBooking(rows[0]));
});

app.delete("/bookings/:id", async (c) => {
  const id = c.req.param("id");
  // Cancelling flips the status, which takes the row out of the unique index and frees the slot.
  const { rows } = await pool.query(
    `UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed'
     RETURNING id, slot_id, name, email, status, created_at`,
    [id],
  );
  if (rows.length > 0) return c.json(toBooking(rows[0]));
  const existing = await pool.query("SELECT 1 FROM bookings WHERE id = $1", [id]);
  return send(c, existing.rowCount ? fail(409, "booking is already cancelled") : fail(404, "booking not found"));
});

// ---------------------------------------------------------------- Web page

app.get("/", (c) => c.html(PAGE_HTML));

// The page calls these. Only the routes a patient needs are forwarded (no /reset, no listing
// other people's bookings), with the API key added on the server.
const UI_ROUTES: [string, RegExp][] = [
  ["GET", /^\/slots$/],
  ["POST", /^\/bookings$/],
  ["GET", /^\/bookings\/[^/]+$/],
  ["DELETE", /^\/bookings\/[^/]+$/],
];

app.all("/ui/*", async (c) => {
  const path = c.req.path.slice("/ui".length);
  const method = c.req.method;
  if (!UI_ROUTES.some(([m, re]) => m === method && re.test(path))) return send(c, fail(404, "not found"));

  const url = new URL(c.req.url);
  url.pathname = path;
  const headers = new Headers({ "x-api-key": API_KEY });
  for (const name of ["content-type", "idempotency-key"]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  const body = method === "POST" ? await c.req.text() : undefined;
  return app.fetch(new Request(url, { method, headers, body }));
});
