const fs = require("fs");
const path = require("path");

const PRIMEGOV_BASE = "https://cityofpaloalto.primegov.com";
const COMMITTEES_FILE = path.join(__dirname, "..", "data", "committees.json");

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function extractCommitteeName(title) {
  for (const suffix of [
    " Regular Meeting",
    " Special Meeting",
    " Meeting",
  ]) {
    const idx = title.indexOf(suffix);
    if (idx > -1) return title.substring(0, idx);
  }
  return title;
}

function sanitize(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .replace(/ - CANCELED$/, "")
    .trim();
}

async function main() {
  const currentYear = new Date().getFullYear();
  const [upcoming, archived] = await Promise.all([
    fetchJSON(`${PRIMEGOV_BASE}/api/v2/PublicPortal/ListUpcomingMeetings`),
    fetchJSON(
      `${PRIMEGOV_BASE}/api/v2/PublicPortal/ListArchivedMeetings?year=${currentYear}`
    ),
  ]);

  const existing = fs.existsSync(COMMITTEES_FILE)
    ? JSON.parse(fs.readFileSync(COMMITTEES_FILE, "utf-8"))
    : {};

  const discovered = {};
  for (const m of [...upcoming, ...archived]) {
    const id = String(m.committeeId);
    if (!discovered[id]) {
      discovered[id] = sanitize(extractCommitteeName(m.title));
    }
  }

  const merged = { ...existing };
  let added = 0;
  for (const [id, name] of Object.entries(discovered)) {
    if (!merged[id]) {
      merged[id] = name;
      added++;
      console.log(`  New committee: ${id} = ${name}`);
    }
  }

  const sorted = {};
  for (const key of Object.keys(merged).sort((a, b) => Number(a) - Number(b))) {
    sorted[key] = merged[key];
  }

  fs.writeFileSync(COMMITTEES_FILE, JSON.stringify(sorted, null, 2) + "\n", "utf-8");

  if (added > 0) {
    console.log(`Added ${added} new committee(s) to committees.json`);
  } else {
    console.log("committees.json is up to date");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
