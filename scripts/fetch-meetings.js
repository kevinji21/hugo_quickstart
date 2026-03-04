const fs = require("fs");
const path = require("path");

const PRIMEGOV_BASE = "https://cityofpaloalto.primegov.com";
const POSTS_DIR = path.join(__dirname, "..", "content", "posts");
const COMMITTEES_FILE = path.join(__dirname, "..", "data", "committees.json");
const DEFAULT_COMMITTEE_IDS = [9];

function loadCommittees() {
  return JSON.parse(fs.readFileSync(COMMITTEES_FILE, "utf-8"));
}

function getTargetCommitteeIds() {
  const env = process.env.COMMITTEE_IDS;
  if (!env || env === "all") {
    const committees = loadCommittees();
    return Object.keys(committees).map(Number);
  }
  if (env === "default") return DEFAULT_COMMITTEE_IDS;
  return env.split(",").map((s) => Number(s.trim()));
}

function slugifyCommittee(name) {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchHTML(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function stripHTML(html) {
  return html
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#160;/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function postSlug(dateStr, committeeName) {
  const d = new Date(dateStr);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}-${slugifyCommittee(committeeName)}`;
}

function getExistingSlugs() {
  if (!fs.existsSync(POSTS_DIR)) return new Set();
  return new Set(
    fs
      .readdirSync(POSTS_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
  );
}

function getYearsToFetch() {
  const currentYear = new Date().getFullYear();
  const fromDate = process.env.FROM_DATE;
  if (!fromDate) return [currentYear];

  const fromYear = new Date(fromDate).getFullYear();
  const years = [];
  for (let y = fromYear; y <= currentYear; y++) {
    years.push(y);
  }
  return years;
}

function getFromDate() {
  const env = process.env.FROM_DATE;
  return env ? new Date(env) : null;
}

async function fetchMeetings(committeeIds) {
  const years = getYearsToFetch();
  const fromDate = getFromDate();

  const fetches = [
    fetchJSON(`${PRIMEGOV_BASE}/api/v2/PublicPortal/ListUpcomingMeetings`),
    ...years.map((y) =>
      fetchJSON(
        `${PRIMEGOV_BASE}/api/v2/PublicPortal/ListArchivedMeetings?year=${y}`
      )
    ),
  ];
  const results = await Promise.all(fetches);
  const all = results.flat();

  const idSet = new Set(committeeIds);
  const seen = new Set();
  return all.filter((m) => {
    if (!idSet.has(m.committeeId)) return false;
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    if (fromDate && new Date(m.dateTime) < fromDate) return false;
    return true;
  });
}

function findHTMLAgendaDocId(meeting) {
  const htmlDoc = meeting.documentList.find(
    (d) => d.compileOutputType === 3 && d.templateName === "HTML Agenda"
  );
  return htmlDoc ? htmlDoc.id : null;
}

async function fetchAgendaText(docId) {
  const url = `${PRIMEGOV_BASE}/Portal/Meeting?compiledMeetingDocumentFileId=${docId}`;
  const html = await fetchHTML(url);

  const bodyStart = html.indexOf("<body");
  if (bodyStart === -1) return null;

  return stripHTML(html.substring(bodyStart));
}

async function summarizeWithAI(agendaText, meetingTitle, meetingDate) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    throw new Error("GEMINI_API_KEY environment variable is not set");

  const truncated = agendaText.slice(0, 12000);

  const prompt = `You are a local government journalist summarizing a Palo Alto city meeting for residents.

Given the following agenda for "${meetingTitle}" on ${meetingDate}, write a blog post summary.

Rules:
- Start with a "## Summary" section: a brief paragraph describing the meeting, then bullet points of key actions/decisions/discussion items.
- Then a "## Agenda Highlights" section with short descriptions of notable agenda items.
- Use plain, accessible language. No jargon.
- Be factual and neutral.
- Do NOT include links, frontmatter, or a title.
- Keep it concise (200-400 words).

Agenda content:
${truncated}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1000,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.candidates[0].content.parts[0].text.trim();
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function toISOWithTZ(dateStr) {
  const d = new Date(dateStr);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:00-08:00`;
}

function sanitizeTitle(title) {
  return title
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function writePost(slug, meeting, summary) {
  const title = sanitizeTitle(meeting.title);
  const dateFormatted = formatDate(meeting.dateTime);
  const isoDate = toISOWithTZ(meeting.dateTime);

  const videoLine = meeting.videoUrl
    ? `- **Meeting video:** [Watch on YouTube](${meeting.videoUrl})`
    : `- **Meeting video:** [City of Palo Alto YouTube](https://www.youtube.com/@cityofpaloalto)`;

  const content = `+++
date = '${isoDate}'
draft = false
title = '${title} – ${dateFormatted}'
+++
${summary}

## Links

${videoLine}
- **Agenda:** [View agenda](${PRIMEGOV_BASE}/public/portal)
- **City Clerk:** [Meeting Agendas and Minutes](https://www.paloalto.gov/Departments/City-Clerk/City-Meeting-Groups/Meeting-Agendas-and-Minutes)
`;

  const filePath = path.join(POSTS_DIR, `${slug}.md`);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

async function main() {
  const committees = loadCommittees();
  const committeeIds = getTargetCommitteeIds();
  const committeeNames = committeeIds.map(
    (id) => committees[String(id)] || `Committee ${id}`
  );

  console.log(`Targeting committees: ${committeeNames.join(", ")}`);
  if (process.env.FROM_DATE) {
    console.log(`Fetching meetings from ${process.env.FROM_DATE} onward...`);
  }
  console.log("Fetching meetings from PrimeGov...");

  const meetings = await fetchMeetings(committeeIds);
  console.log(`Found ${meetings.length} meetings`);

  const existingSlugs = getExistingSlugs();
  let created = 0;

  for (const meeting of meetings) {
    const committeeName =
      committees[String(meeting.committeeId)] ||
      `committee-${meeting.committeeId}`;
    const slug = postSlug(meeting.dateTime, committeeName);

    if (existingSlugs.has(slug)) {
      console.log(`  Skipping ${slug} (post already exists)`);
      continue;
    }

    if (meeting.title.includes("CANCELED")) {
      console.log(`  Skipping ${slug} (meeting canceled)`);
      continue;
    }

    const docId = findHTMLAgendaDocId(meeting);
    if (!docId) {
      console.log(`  Skipping ${slug} (no HTML agenda available yet)`);
      continue;
    }

    console.log(`  Processing ${slug}: ${meeting.title}...`);

    const agendaText = await fetchAgendaText(docId);
    if (!agendaText) {
      console.log(`    Could not extract agenda text, skipping`);
      continue;
    }

    console.log(`    Agenda text: ${agendaText.length} chars, summarizing...`);
    const summary = await summarizeWithAI(
      agendaText,
      meeting.title,
      formatDate(meeting.dateTime)
    );

    const filePath = writePost(slug, meeting, summary);
    console.log(`    Created: ${filePath}`);
    created++;
  }

  console.log(`\nDone. Created ${created} new post(s).`);
  if (created > 0 && process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, "new_posts=true\n");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
