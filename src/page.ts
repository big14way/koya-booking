// The patient-facing page, served at "/". It talks to the API through /ui/*, which adds the
// API key on the server, so the key is never shipped to the browser.
export const PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Book an appointment</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #fff; --text: #16202b; --muted: #5d6b7a; --line: #e2e6eb;
    --accent: #0f6e5c; --accent-soft: #e3f2ee; --danger: #b3261e; --danger-soft: #fbe9e7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #11161c; --card: #1a2129; --text: #e8edf2; --muted: #9aa8b6; --line: #2b3540;
      --accent: #4cc2a6; --accent-soft: #173a33; --danger: #ff8a80; --danger-soft: #3a1d1b;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; }
  h2 { font-size: 1.1rem; margin: 0 0 12px; }
  .sub { color: var(--muted); margin: 0 0 24px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .day { margin: 16px 0 8px; font-weight: 600; color: var(--muted); font-size: .9rem; }
  .day:first-child { margin-top: 0; }
  .slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
  .slot { text-align: left; border: 1px solid var(--line); background: var(--card); color: var(--text);
          border-radius: 10px; padding: 10px 12px; cursor: pointer; font: inherit; }
  .slot:hover:not(:disabled) { border-color: var(--accent); }
  .slot[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); }
  .slot:disabled { opacity: .45; cursor: not-allowed; text-decoration: line-through; }
  .slot b { display: block; }
  .slot span { color: var(--muted); font-size: .85rem; }
  label { display: block; font-weight: 600; font-size: .9rem; margin: 12px 0 4px; }
  input { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px;
          background: var(--bg); color: var(--text); font: inherit; }
  button.primary, button.secondary { margin-top: 16px; border: 0; border-radius: 8px; padding: 10px 16px;
          font: inherit; font-weight: 600; cursor: pointer; }
  button.primary { background: var(--accent); color: #fff; }
  button.secondary { background: transparent; color: var(--text); border: 1px solid var(--line); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  button:disabled.primary { opacity: .6; cursor: wait; }
  .error { background: var(--danger-soft); color: var(--danger); border-radius: 8px; padding: 10px 12px; margin-top: 12px; }
  .ok { border-color: var(--accent); }
  .ok h2 { color: var(--accent); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
  dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
  .muted { color: var(--muted); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>Book an appointment</h1>
  <p class="sub">Pick a free slot, add your details, and we'll confirm it straight away.</p>

  <section class="card" id="pick">
    <h2>1. Choose a slot</h2>
    <div id="slots"><p class="muted">Loading slots…</p></div>
  </section>

  <form class="card" id="form" hidden>
    <h2>2. Your details</h2>
    <p class="muted" id="chosen"></p>
    <label for="name">Full name</label>
    <input id="name" name="name" autocomplete="name" required>
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" required>
    <div class="error" id="form-error" hidden></div>
    <button class="primary" id="submit" type="submit">Book this slot</button>
  </form>

  <section class="card ok" id="confirmation" hidden>
    <h2 id="conf-title">You're booked</h2>
    <dl id="conf-details"></dl>
    <div class="error" id="conf-error" hidden></div>
    <div class="actions">
      <button class="secondary" id="cancel" type="button">Cancel booking</button>
      <button class="secondary" id="again" type="button">Book another</button>
    </div>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
let slots = [];
let selected = null;
let idempotencyKey = null; // one key per booking attempt, reused if the same attempt is retried

async function api(method, path, body, headers = {}) {
  const res = await fetch("/ui" + path, {
    method,
    headers: body ? { "Content-Type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data, retryAfter: res.headers.get("Retry-After") };
}

function when(slot) {
  const start = new Date(slot.start), end = new Date(slot.end);
  return fmtDay.format(start) + ", " + fmtTime.format(start) + " – " + fmtTime.format(end);
}

async function loadSlots() {
  const { ok, data } = await api("GET", "/slots");
  const box = $("slots");
  if (!ok) { box.innerHTML = '<p class="error">Couldn\\'t load slots. Refresh to try again.</p>'; return; }
  const now = Date.now();
  slots = data.slots.filter((s) => new Date(s.start).getTime() > now);
  if (slots.length === 0) { box.innerHTML = '<p class="muted">No upcoming slots right now.</p>'; return; }

  box.innerHTML = "";
  let day = null, grid = null;
  for (const s of slots) {
    const d = fmtDay.format(new Date(s.start));
    if (d !== day) {
      day = d;
      const h = document.createElement("div"); h.className = "day"; h.textContent = d; box.append(h);
      grid = document.createElement("div"); grid.className = "slots"; box.append(grid);
    }
    const b = document.createElement("button");
    b.type = "button"; b.className = "slot"; b.disabled = !s.available;
    b.setAttribute("aria-pressed", String(selected?.id === s.id));
    b.title = s.available ? "Book this slot" : "Already booked";
    b.innerHTML = "<b></b><span></span>";
    b.querySelector("b").textContent = fmtTime.format(new Date(s.start));
    b.querySelector("span").textContent = s.provider + (s.available ? "" : " · booked");
    b.onclick = () => choose(s);
    grid.append(b);
  }
}

function choose(slot) {
  selected = slot;
  idempotencyKey = crypto.randomUUID();
  $("chosen").textContent = slot.provider + " · " + when(slot);
  $("form-error").hidden = true;
  $("form").hidden = false;
  document.querySelectorAll(".slot").forEach((b) => b.setAttribute("aria-pressed", "false"));
  loadSlots();
  $("name").focus();
}

$("form").onsubmit = async (e) => {
  e.preventDefault();
  const btn = $("submit");
  btn.disabled = true; btn.textContent = "Booking…";
  const { ok, status, data, retryAfter } = await api(
    "POST", "/bookings",
    { slot_id: selected.id, name: $("name").value, email: $("email").value },
    { "Idempotency-Key": idempotencyKey },
  );
  btn.disabled = false; btn.textContent = "Book this slot";
  if (ok) return showConfirmation(data);

  let message = data.error || "Something went wrong. Please try again.";
  if (status === 409) message = "Sorry, someone just booked that slot. Please pick another.";
  if (status === 429) message = "Too many attempts. Please wait " + (retryAfter || "a few") + " seconds and try again.";
  $("form-error").textContent = message;
  $("form-error").hidden = false;
  // A different request needs a fresh key; a 429 can be retried with the same one.
  if (status !== 429) idempotencyKey = crypto.randomUUID();
  if (status === 409 || status === 404) { selected = null; $("form").hidden = true; loadSlots(); }
};

function showConfirmation(booking) {
  const slot = slots.find((s) => s.id === booking.slot_id) || selected;
  $("conf-title").textContent = booking.status === "confirmed" ? "You're booked" : "Booking cancelled";
  const rows = [
    ["With", slot ? slot.provider : "—"],
    ["When", slot ? when(slot) : "—"],
    ["Name", booking.name],
    ["Email", booking.email],
    ["Status", booking.status],
    ["Reference", booking.id],
  ];
  $("conf-details").innerHTML = "";
  for (const [k, v] of rows) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    $("conf-details").append(dt, dd);
  }
  $("cancel").hidden = booking.status !== "confirmed";
  $("cancel").onclick = () => cancel(booking.id);
  $("conf-error").hidden = true;
  $("form").hidden = true;
  $("pick").hidden = true;
  $("confirmation").hidden = false;
}

async function cancel(id) {
  const { ok, data } = await api("DELETE", "/bookings/" + encodeURIComponent(id));
  if (!ok) { $("conf-error").textContent = data.error || "Couldn't cancel."; $("conf-error").hidden = false; return; }
  showConfirmation(data);
}

$("again").onclick = () => {
  selected = null;
  $("confirmation").hidden = true; $("pick").hidden = false; $("form").reset();
  loadSlots();
};

loadSlots();
</script>
</body>
</html>`;
