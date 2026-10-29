// Contract tests against a running API, level by level.
// Local:    npm run dev   then   npm test
// Deployed: BASE_URL=https://... npm test
// Note: each run calls /reset, which wipes all slots and bookings.

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const KEY = process.env.API_KEY ?? "";

type Res = { status: number; body: any; headers: Headers };

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "X-API-Key": KEY, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed, headers: res.headers };
}

const iso = (minutesFromNow: number) => new Date(Math.floor(Date.now() / 60000) * 60000 + minutesFromNow * 60000).toISOString().replace(".000Z", "Z");
let run = 0;
const email = (tag: string) => `${tag}.${Date.now()}.${run++}@example.com`;

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function expectStatus(r: Res, status: number, what: string) {
  check(r.status === status, `${what}: expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  if (status >= 400) check(typeof r.body?.error === "string", `${what}: error body should be {"error": "..."}`);
}

async function reset(count = 30) {
  const slots = [{ id: "past", provider: "Dr Ade", start: iso(-120), end: iso(-90) }];
  for (let i = 1; i <= count; i++) {
    slots.push({ id: `s${i}`, provider: i % 2 ? "Dr Ade" : "Dr Bello", start: iso(60 * 24 + i * 30), end: iso(60 * 24 + i * 30 + 30) });
  }
  expectStatus(await call("POST", "/reset", { slots }), 200, "reset");
  return slots;
}

const tests: [string, () => Promise<void>][] = [
  ["L1 reset + list slots, earliest first, with availability", async () => {
    const sent = await reset();
    const r = await call("GET", "/slots");
    expectStatus(r, 200, "GET /slots");
    check(r.body.slots.length === sent.length, "all slots returned");
    check(r.body.slots[0].id === "past", "earliest first");
    check(r.body.slots[1].start === sent[1].start, "start echoed exactly as sent");
    check(r.body.slots.every((s: any) => s.available === true), "all available after reset");
    const ade = await call("GET", "/slots?provider=Dr%20Bello");
    check(ade.body.slots.length > 0 && ade.body.slots.every((s: any) => s.provider === "Dr Bello"), "provider filter");
  }],
  ["L1 book a slot, look it up, slot shows unavailable", async () => {
    const r = await call("POST", "/bookings", { slot_id: "s1", name: "Ada Obi", email: email("ada") });
    expectStatus(r, 201, "book");
    check(r.body.status === "confirmed" && r.body.id && r.body.created_at, "booking shape");
    const g = await call("GET", `/bookings/${r.body.id}`);
    expectStatus(g, 200, "get booking");
    check(g.body.id === r.body.id && g.body.slot_id === "s1", "same booking");
    const slots = await call("GET", "/slots");
    check(slots.body.slots.find((s: any) => s.id === "s1").available === false, "s1 unavailable");
    expectStatus(await call("GET", "/bookings/nope"), 404, "unknown booking");
  }],
  ["L2 API key required", async () => {
    const none = await fetch(BASE + "/slots");
    check(none.status === 401, `no key: got ${none.status}`);
    const wrong = await fetch(BASE + "/slots", { headers: { "X-API-Key": "wrong" } });
    check(wrong.status === 401, `wrong key: got ${wrong.status}`);
    const reset = await fetch(BASE + "/reset", { method: "POST", body: "{}" });
    check(reset.status === 401, `reset without key: got ${reset.status}`);
  }],
  ["L2 validation: 400 / 404 / started slot", async () => {
    const e = email("val");
    expectStatus(await call("POST", "/bookings", { name: "A", email: e }), 400, "missing slot_id");
    expectStatus(await call("POST", "/bookings", { slot_id: "s2", name: "  ", email: e }), 400, "blank name");
    expectStatus(await call("POST", "/bookings", { slot_id: "s2", name: "A", email: "" }), 400, "empty email");
    expectStatus(await call("POST", "/bookings", { slot_id: "s2", name: "A", email: "not-an-email" }), 400, "invalid email");
    expectStatus(await call("POST", "/bookings", "{oops", {}), 400, "malformed JSON");
    const e2 = email("val2");
    expectStatus(await call("POST", "/bookings", { slot_id: "missing", name: "A", email: e2 }), 404, "unknown slot");
    expectStatus(await call("POST", "/bookings", { slot_id: "past", name: "A", email: e2 }), 400, "slot already started");
  }],
  ["L2 trims name/email and lower-cases email", async () => {
    const e = email("Trim");
    const r = await call("POST", "/bookings", { slot_id: "s2", name: "  Ada Obi  ", email: `  ${e.toUpperCase()}  ` });
    expectStatus(r, 201, "book");
    check(r.body.name === "Ada Obi" && r.body.email === e.toLowerCase(), `got ${r.body.name} / ${r.body.email}`);
  }],
  ["L3 double booking: 409, even with 25 requests at once", async () => {
    expectStatus(await call("POST", "/bookings", { slot_id: "s2", name: "B", email: email("dup") }), 409, "already booked");
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => call("POST", "/bookings", { slot_id: "s3", name: `P${i}`, email: email(`race${i}`) })),
    );
    const codes = results.map((r) => r.status);
    check(codes.filter((c) => c === 201).length === 1, `exactly one 201, got ${JSON.stringify(codes)}`);
    check(codes.filter((c) => c === 409).length === 24, `the rest 409, got ${JSON.stringify(codes)}`);
  }],
  ["L3 cancel frees the slot; cancelling twice is 409", async () => {
    const b = await call("POST", "/bookings", { slot_id: "s4", name: "C", email: email("cancel") });
    expectStatus(b, 201, "book");
    const d = await call("DELETE", `/bookings/${b.body.id}`);
    expectStatus(d, 200, "cancel");
    check(d.body.status === "cancelled", "status cancelled");
    expectStatus(await call("DELETE", `/bookings/${b.body.id}`), 409, "cancel again");
    expectStatus(await call("DELETE", "/bookings/nope"), 404, "cancel unknown");
    const again = await call("POST", "/bookings", { slot_id: "s4", name: "D", email: email("rebook") });
    expectStatus(again, 201, "rebook freed slot");
  }],
  ["L4 idempotency: retries replay, different body is 422", async () => {
    const key = `idem-${Date.now()}`;
    const body = { slot_id: "s5", name: "E", email: email("idem") };
    const first = await call("POST", "/bookings", body, { "Idempotency-Key": key });
    expectStatus(first, 201, "first");
    const retry = await call("POST", "/bookings", { email: body.email, name: body.name, slot_id: body.slot_id }, { "Idempotency-Key": key });
    expectStatus(retry, 201, "retry (same body, keys reordered)");
    check(retry.body.id === first.body.id, "same booking id");
    expectStatus(await call("POST", "/bookings", { ...body, name: "Other" }, { "Idempotency-Key": key }), 422, "different body");
    const failKey = `idem-fail-${Date.now()}`;
    const failBody = { slot_id: "s5", name: "F", email: email("idemfail") };
    expectStatus(await call("POST", "/bookings", failBody, { "Idempotency-Key": failKey }), 409, "booked slot");
    expectStatus(await call("POST", "/bookings", failBody, { "Idempotency-Key": failKey }), 409, "error response replayed");
  }],
  ["L4 idempotency under concurrency: 10 simultaneous retries, one booking", async () => {
    const key = `idem-race-${Date.now()}`;
    const body = { slot_id: "s6", name: "G", email: email("idemrace") };
    const results = await Promise.all(Array.from({ length: 10 }, () => call("POST", "/bookings", body, { "Idempotency-Key": key })));
    check(results.every((r) => r.status === 201), `all 201, got ${results.map((r) => r.status)}`);
    check(new Set(results.map((r) => r.body.id)).size === 1, "one booking id");
  }],
  ["L4 list a person's bookings with cursor pages, oldest first, case-insensitive", async () => {
    const e = email("pages");
    const ids: string[] = [];
    for (const slot of ["s10", "s11", "s12", "s13", "s14"]) {
      const r = await call("POST", "/bookings", { slot_id: slot, name: "H", email: e });
      expectStatus(r, 201, `book ${slot}`);
      ids.push(r.body.id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const q = `/bookings?email=${encodeURIComponent(e.toUpperCase())}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await call("GET", q);
      expectStatus(page, 200, "page");
      check(page.body.bookings.length <= 2, "page size");
      seen.push(...page.body.bookings.map((b: any) => b.id));
      cursor = page.body.next_cursor;
    } while (cursor);
    check(JSON.stringify(seen) === JSON.stringify(ids), `oldest first, no gaps: ${seen.length}/${ids.length}`);
    for (const bad of ["0", "51", "abc", "2.5", "-1"]) {
      expectStatus(await call("GET", `/bookings?email=${encodeURIComponent(e)}&limit=${bad}`), 400, `limit=${bad}`);
    }
    const def = await call("GET", `/bookings?email=${encodeURIComponent(e)}`);
    check(def.body.bookings.length === 5 && def.body.next_cursor === null, "default limit, last page null");
  }],
  ["L5 rate limit: 6th attempt in a minute is 429 with Retry-After; other emails fine", async () => {
    const e = email("spam");
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await call("POST", "/bookings", { slot_id: "missing", name: "S", email: e })).status);
    check(codes.every((c) => c === 404), `first 5 are normal failures, got ${codes}`);
    const sixth = await call("POST", "/bookings", { slot_id: "s20", name: "S", email: e });
    expectStatus(sixth, 429, "6th attempt");
    const ra = Number(sixth.headers.get("retry-after"));
    check(Number.isInteger(ra) && ra >= 1 && ra <= 60, `Retry-After whole seconds, got ${sixth.headers.get("retry-after")}`);
    expectStatus(await call("POST", "/bookings", { slot_id: "s20", name: "T", email: email("other") }), 201, "other email unaffected");
  }],
  ["L5 rate limit holds under a simultaneous burst", async () => {
    const e = email("burst");
    const results = await Promise.all(Array.from({ length: 12 }, () => call("POST", "/bookings", { slot_id: "missing", name: "S", email: e })));
    const codes = results.map((r) => r.status);
    check(codes.filter((c) => c !== 429).length === 5, `exactly 5 let through, got ${JSON.stringify(codes)}`);
  }],
];

let failed = 0;
console.log(`Testing ${BASE}\n`);
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(err as Error).message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
