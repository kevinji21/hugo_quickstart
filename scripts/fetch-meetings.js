const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");

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

function findDoc(meeting, templateName, outputType) {
  return (
    meeting.documentList.find(
      (d) => d.templateName === templateName && d.compileOutputType === outputType
    ) || null
  );
}

function htmlDocUrl(docId) {
  return `${PRIMEGOV_BASE}/Portal/Meeting?compiledMeetingDocumentFileId=${docId}`;
}

function pdfDocUrl(templateId) {
  return `${PRIMEGOV_BASE}/Public/CompiledDocument?meetingTemplateId=${templateId}&compileOutputType=1`;
}

function pdfViewerUrl(docId) {
  return `${PRIMEGOV_BASE}/viewer/preview?id=${docId}&type=1`;
}

async function fetchHTMLDocText(docId) {
  const url = htmlDocUrl(docId);
  const html = await fetchHTML(url);
  const bodyStart = html.indexOf("<body");
  if (bodyStart === -1) return null;
  return stripHTML(html.substring(bodyStart));
}

async function fetchPDFText(templateId) {
  const url = pdfDocUrl(templateId);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  const pdf = await pdfParse(buffer);
  return pdf.text.trim();
}

const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_RETRIES = 3;

async function summarizeWithAI(sourceText, meetingTitle, meetingDate, sourceType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    throw new Error("GEMINI_API_KEY environment variable is not set");

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const truncated = sourceText.slice(0, 12000);

  const sourceLabel =
    sourceType === "minutes"
      ? "meeting minutes"
      : sourceType === "action-minutes"
        ? "action minutes"
        : "agenda";

  const actionMinutesNote =
    sourceType === "action-minutes"
      ? `\n- Begin the summary with a note: "*This summary is based on action minutes. Full summary minutes were not available for this meeting.*"\n`
      : "";

  const prompt = `You are a local government journalist summarizing a Palo Alto city meeting for residents.

Given the following ${sourceLabel} for "${meetingTitle}" on ${meetingDate}, write a blog post summary.

Rules:
- Start with a "## Summary" section: a brief paragraph describing the meeting, then bullet points of key actions/decisions/discussion items.
- Then a "## Agenda Highlights" section: for each agenda item, give a short plain-language description of what was discussed or decided.
- Use plain, accessible language. No jargon.
- Be factual and neutral.
- Do NOT include links, frontmatter, or a title.
- Keep it concise (300-500 words).${actionMinutesNote}

${sourceLabel} content:
${truncated}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 4096,
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

function docUrl(doc) {
  if (doc.compileOutputType === 3) {
    return htmlDocUrl(doc.id);
  }
  return pdfViewerUrl(doc.id);
}

function writePost(slug, meeting, summary, links) {
  if (!fs.existsSync(POSTS_DIR)) {
    fs.mkdirSync(POSTS_DIR, { recursive: true });
  }
  const title = sanitizeTitle(meeting.title);
  const dateFormatted = formatDate(meeting.dateTime);
  const isoDate = toISOWithTZ(meeting.dateTime);

  const linkLines = [];

  if (links.videoUrl) {
    linkLines.push(
      `- **Meeting video:** [Watch on YouTube](${links.videoUrl})`
    );
  } else {
    linkLines.push(
      `- **Meeting video:** [City of Palo Alto YouTube](https://www.youtube.com/@cityofpaloalto)`
    );
  }

  if (meeting.documentList && meeting.documentList.length > 0) {
    for (const doc of meeting.documentList) {
      const url = docUrl(doc);
      const format = doc.compileOutputType === 3 ? "HTML" : "PDF";
      linkLines.push(`- **${doc.templateName}:** [View ${doc.templateName.toLowerCase()}](${url}) (${format})`);
    }
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

    if (existingSlugs.has(slug) && postHasSummary(slug)) {
      console.log(`  Skipping ${slug} (post with summary already exists)`);
      continue;
    }

    const agendaDoc = findDoc(meeting, "HTML Agenda", 3);
    const minutesDoc = findDoc(meeting, "Summary Minutes", 1);
    const actionMinutesDoc = findDoc(meeting, "Action Minutes", 1);
    const packetDoc = findDoc(meeting, "Packet", 1);

    if (!agendaDoc) {
      console.log(`  Skipping ${slug} (no HTML agenda available yet)`);
      continue;
    }

    const links = {
      videoUrl: meeting.videoUrl || null,
    };

    // Prefer summary minutes, then action minutes, then HTML agenda
    let sourceText = null;
    let sourceType = null;

    if (minutesDoc) {
      console.log(`  Fetching summary minutes PDF for ${slug}: ${meeting.title}...`);
      try {
        sourceText = await fetchPDFText(minutesDoc.templateId);
        sourceType = "minutes";
        if (sourceText) {
          console.log(`    Summary minutes text: ${sourceText.length} chars`);
        }
      } catch (err) {
        console.warn(`    Could not extract summary minutes PDF: ${err.message}`);
      }
    }

    if (!sourceText && actionMinutesDoc) {
      console.log(`  Fetching action minutes PDF for ${slug}: ${meeting.title}...`);
      try {
        sourceText = await fetchPDFText(actionMinutesDoc.templateId);
        sourceType = "action-minutes";
        if (sourceText) {
          console.log(`    Action minutes text: ${sourceText.length} chars`);
        }
      } catch (err) {
        console.warn(`    Could not extract action minutes PDF: ${err.message}`);
      }
    }

    if (!sourceText) {
      console.log(`  Fetching HTML agenda for ${slug}: ${meeting.title}...`);
      sourceText = await fetchHTMLDocText(agendaDoc.id);
      sourceType = "agenda";
    }

    if (!sourceText) {
      console.log(`    Could not extract any document text, skipping`);
      continue;
    }

    if (!existingSlugs.has(slug)) {
      const placeholder = `*Summary pending — ${sourceType} has ${sourceText.length} characters.*`;
      writePost(slug, meeting, placeholder, links);
      console.log(`    Created placeholder post: ${slug}`);
      created++;
    }

    needsAISummary.push({ slug, meeting, sourceText, sourceType, links });
  }

  const DELAY_MS = 2000;

  if (!process.env.GEMINI_API_KEY) {
    console.log(
      `\nNo GEMINI_API_KEY set — skipping AI summarization for ${needsAISummary.length} meeting(s).`
    );
    for (const { slug, meeting, links } of needsAISummary) {
      if (!postHasSummary(slug)) {
        const notice = `*AI summary not available — GEMINI_API_KEY was not configured when this post was generated. Re-run with the API key set to generate a summary.*`;
        writePost(slug, meeting, notice, links);
      }
    }
  } else {
    for (const { slug, meeting, sourceText, sourceType, links } of needsAISummary) {
      console.log(`  Summarizing ${slug} from ${sourceType} with AI...`);
      try {
        const summary = await summarizeWithAI(
          sourceText,
          meeting.title,
          formatDate(meeting.dateTime),
          sourceType
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
