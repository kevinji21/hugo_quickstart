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

  const fetches = years.map((y) =>
    fetchJSON(
      `${PRIMEGOV_BASE}/api/v2/PublicPortal/ListArchivedMeetings?year=${y}`
    )
  );
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

function findDocId(meeting, templateName) {
  const doc = meeting.documentList.find(
    (d) => d.compileOutputType === 3 && d.templateName === templateName
  );
  return doc ? doc.id : null;
}

function findHTMLAgendaDocId(meeting) {
  return findDocId(meeting, "HTML Agenda");
}

function findMinutesDocId(meeting) {
  return (
    findDocId(meeting, "HTML Minutes") ||
    findDocId(meeting, "HTML Summary") ||
    findDocId(meeting, "Meeting Summary")
  );
}

function meetingDocUrl(docId) {
  return `${PRIMEGOV_BASE}/Portal/Meeting?compiledMeetingDocumentFileId=${docId}`;
}

async function fetchDocText(docId) {
  const url = meetingDocUrl(docId);
  const html = await fetchHTML(url);

  const bodyStart = html.indexOf("<body");
  if (bodyStart === -1) return null;

  return stripHTML(html.substring(bodyStart));
}

const DEFAULT_MODEL = "gemini-2.0-flash-lite";
const MAX_RETRIES = 3;

async function summarizeWithAI(agendaText, meetingTitle, meetingDate) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    throw new Error("GEMINI_API_KEY environment variable is not set");

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1000,
    },
  });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (res.ok) {
      const data = await res.json();
      return data.candidates[0].content.parts[0].text.trim();
    }

    const err = await res.text();

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const backoff = Math.pow(2, attempt) * 5000;
      console.warn(
        `    Rate limited (attempt ${attempt}/${MAX_RETRIES}), retrying in ${backoff / 1000}s...`
      );
      await sleep(backoff);
      continue;
    }

    throw new Error(`Gemini API error (${model}): ${res.status} ${err}`);
  }
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

function postHasSummary(slug) {
  const filePath = path.join(POSTS_DIR, `${slug}.md`);
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, "utf-8");
  return content.includes("## Summary");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writePost(slug, meeting, summary, links) {
  const title = sanitizeTitle(meeting.title);
  const dateFormatted = formatDate(meeting.dateTime);
  const isoDate = toISOWithTZ(meeting.dateTime);

  const linkLines = [];

  if (links.agendaUrl) {
    linkLines.push(`- **Agenda:** [View agenda](${links.agendaUrl})`);
  }

  if (links.videoUrl) {
    linkLines.push(
      `- **Meeting video:** [Watch on YouTube](${links.videoUrl})`
    );
  } else {
    linkLines.push(
      `- **Meeting video:** [City of Palo Alto YouTube](https://www.youtube.com/@cityofpaloalto)`
    );
  }

  if (links.minutesUrl) {
    linkLines.push(
      `- **Summary notes:** [View meeting notes](${links.minutesUrl})`
    );
  }

  const content = `+++
date = '${isoDate}'
draft = false
title = '${title} – ${dateFormatted}'
+++
${summary}

## Links

${linkLines.join("\n")}
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
  let summarized = 0;
  const needsAISummary = [];

  for (const meeting of meetings) {
    const committeeName =
      committees[String(meeting.committeeId)] ||
      `committee-${meeting.committeeId}`;
    const slug = postSlug(meeting.dateTime, committeeName);

    if (meeting.title.includes("CANCELED")) {
      console.log(`  Skipping ${slug} (meeting canceled)`);
      continue;
    }

    const docId = findHTMLAgendaDocId(meeting);
    if (!docId) {
      console.log(`  Skipping ${slug} (no HTML agenda available yet)`);
      continue;
    }

    if (existingSlugs.has(slug) && postHasSummary(slug)) {
      console.log(`  Skipping ${slug} (post with summary already exists)`);
      continue;
    }

    const minutesDocId = findMinutesDocId(meeting);

    const links = {
      agendaUrl: meetingDocUrl(docId),
      videoUrl: meeting.videoUrl || null,
      minutesUrl: minutesDocId ? meetingDocUrl(minutesDocId) : null,
    };

    // If official minutes exist, use them directly (no Gemini needed)
    if (minutesDocId) {
      console.log(`  Fetching minutes for ${slug}: ${meeting.title}...`);
      const minutesText = await fetchDocText(minutesDocId);
      if (minutesText) {
        const summary = `## Summary\n\n${minutesText}`;
        const filePath = writePost(slug, meeting, summary, links);
        console.log(`    Created post from official minutes: ${filePath}`);
        created++;
        continue;
      }
      console.log(`    Could not extract minutes text, falling back to agenda`);
    }

    // No minutes — will need Gemini to summarize the agenda
    console.log(`  Fetching agenda for ${slug}: ${meeting.title}...`);
    const agendaText = await fetchDocText(docId);
    if (!agendaText) {
      console.log(`    Could not extract agenda text, skipping`);
      continue;
    }

    if (!existingSlugs.has(slug)) {
      const placeholder = `*Summary pending — agenda has ${agendaText.length} characters.*`;
      writePost(slug, meeting, placeholder, links);
      console.log(`    Created placeholder post: ${slug}`);
      created++;
    }

    needsAISummary.push({ slug, meeting, agendaText, links });
  }

  // Generate AI summaries only for posts without official minutes
  const DELAY_MS = 2000;

  for (const { slug, meeting, agendaText, links } of needsAISummary) {
    console.log(`  Summarizing ${slug} with AI...`);
    try {
      const summary = await summarizeWithAI(
        agendaText,
        meeting.title,
        formatDate(meeting.dateTime)
      );
      writePost(slug, meeting, summary, links);
      console.log(`    AI summary written for ${slug}`);
      summarized++;
    } catch (err) {
      console.warn(`    Failed to summarize ${slug}: ${err.message}`);
      console.warn(`    Post exists with placeholder; will retry next run.`);
    }

    await sleep(DELAY_MS);
  }

  console.log(
    `\nDone. Created ${created} new post(s), AI-summarized ${summarized}.`
  );
  if (created > 0 && process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, "new_posts=true\n");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
