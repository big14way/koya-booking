// Fills the API with a week of demo slots (replaces everything via /reset).
// Run: BASE_URL=https://... npm run seed
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const providers = ["Dr Ade Okafor", "Dr Bello Musa", "Dr Chioma Eze"];
const times = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "14:00", "14:30", "15:00", "15:30"];

const slots: { id: string; provider: string; start: string; end: string }[] = [];
const day = new Date();
let added = 0;
while (added < 5) {
  day.setUTCDate(day.getUTCDate() + 1);
  if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue; // weekdays only
  added++;
  const date = day.toISOString().slice(0, 10);
  providers.forEach((provider, p) => {
    // Each doctor works a different part of the day, in Lagos time (UTC+1).
    for (const time of times.filter((_, i) => i % providers.length !== p)) {
      const start = new Date(`${date}T${time}:00+01:00`);
      const end = new Date(start.getTime() + 30 * 60_000);
      const toIso = (d: Date) => d.toISOString().replace(".000Z", "Z");
      slots.push({ id: `${date}-${provider.split(" ")[1].toLowerCase()}-${time.replace(":", "")}`, provider, start: toIso(start), end: toIso(end) });
    }
  });
}

const res = await fetch(`${BASE}/reset`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-API-Key": process.env.API_KEY ?? "" },
  body: JSON.stringify({ slots }),
});
console.log(res.status, await res.text());
