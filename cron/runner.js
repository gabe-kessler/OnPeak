// cron/runner.js
// Long-running Node.js process that fires the three pipeline routes on a schedule.
// Run with:  node cron/runner.js
// Keep alive with: pm2 start cron/runner.js --name onpeak-cron
//
// Schedule (all times Eastern):
//   11:30 AM — create-market:          NYC + Boston (NYISO/ISO-NE DAM)
//    4:30 PM — create-market-bayarea:  Bay Area (CAISO DAM publishes ~1 PM PT)
//   12:05 AM — settle-market:          all 3 nodes
//
// Catch-up strategy:
//   On macOS laptops, the system may be sleeping when a scheduled time fires.
//   node-cron does not re-run missed jobs on wake. To handle this, each
//   create-market job also runs hourly during its valid window as a backup.
//   The API endpoints are idempotent (they skip if the market already exists),
//   so running them multiple times per day is safe.

const cron = require("node-cron");
const http  = require("http");
const https = require("https");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

// ---------------------------------------------------------------------------
// Helper: POST to one of our cron API routes
// ---------------------------------------------------------------------------
function callRoute(path) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${path}`;
    const lib = url.startsWith("https") ? https : http;

    const req = lib.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "0" } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, body }); }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function run(name, path) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] Running ${name}...`);
  try {
    const result = await callRoute(path);
    console.log(`[${ts}] ${name} →`, result.status, JSON.stringify(result.body));
  } catch (err) {
    console.error(`[${ts}] ${name} failed:`, err.message);
  }
}

// GET request helper (for price polling)
function getRoute(path) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${path}`;
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, (res) => {
      res.resume(); // drain response, we don't need the body
      resolve(res.statusCode);
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Job 1 — Create tomorrow's NYC + Boston markets
// Primary: 11:30 AM ET daily (NYISO/ISO-NE DAM publishes ~11 AM ET)
// Catch-up: every hour noon–8 PM ET in case primary was missed while sleeping
// ---------------------------------------------------------------------------
cron.schedule("30 11 * * *", () => run("create-market", "/api/cron/create-market"),
  { timezone: "America/New_York" });

cron.schedule("0 12-20 * * *", () => run("create-market [catch-up]", "/api/cron/create-market"),
  { timezone: "America/New_York" });

// ---------------------------------------------------------------------------
// Job 2 — Create tomorrow's Bay Area market
// Primary: 4:30 PM ET daily (CAISO DAM publishes ~1 PM PT / 4 PM ET)
// Catch-up: every hour 5 PM–midnight ET
// ---------------------------------------------------------------------------
cron.schedule("30 16 * * *", () => run("create-market-bayarea", "/api/cron/create-market-bayarea"),
  { timezone: "America/New_York" });

cron.schedule("0 17-23 * * *", () => run("create-market-bayarea [catch-up]", "/api/cron/create-market-bayarea"),
  { timezone: "America/New_York" });

// ---------------------------------------------------------------------------
// Job 3 — Settle yesterday's markets (all 3 nodes)
// Primary: 12:05 AM ET daily
// Catch-up: 12:30 AM and 1:00 AM in case primary was missed
// ---------------------------------------------------------------------------
cron.schedule("5 0 * * *", () => run("settle-market", "/api/cron/settle-market"),
  { timezone: "America/New_York" });

cron.schedule("30 0 * * *", () => run("settle-market [catch-up]", "/api/cron/settle-market"),
  { timezone: "America/New_York" });

cron.schedule("0 1 * * *", () => run("settle-market [catch-up]", "/api/cron/settle-market"),
  { timezone: "America/New_York" });

// ---------------------------------------------------------------------------
// Job 4 — Poll RT prices every 5 minutes and save snapshots to DB
// Runs all day so price history is captured even when the browser is closed.
// The API endpoint caches the external fetch for 5 min, so this is cheap.
// ---------------------------------------------------------------------------
cron.schedule(
  "*/5 * * * *",
  async () => {
    try { await getRoute("/api/prices/all"); }
    catch (err) { console.error(`[${new Date().toISOString()}] price-poll failed:`, err.message); }
  },
  { timezone: "America/New_York" }
);

// ---------------------------------------------------------------------------
// Startup catch-up — in case this process was just restarted after a missed job
// ---------------------------------------------------------------------------
setTimeout(async () => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] Startup: checking for any missed market creation...`);
  await run("create-market [startup]", "/api/cron/create-market");
  await run("create-market-bayarea [startup]", "/api/cron/create-market-bayarea");
}, 10_000); // 10s delay to let Next.js finish warming up

console.log("OnPeak cron runner started.");
console.log("  create-market:         11:30 AM ET + hourly noon-8PM (daily) — NYC + Boston");
console.log("  create-market-bayarea:  4:30 PM ET + hourly 5PM-midnight (daily) — Bay Area");
console.log("  settle-market:         12:05 AM ET + 12:30 AM + 1:00 AM (daily) — all 3 nodes");
console.log("  price-poll:            every 5 min (always) — snapshots to DB");
console.log(`  BASE_URL: ${BASE_URL}`);
