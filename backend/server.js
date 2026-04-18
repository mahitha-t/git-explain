import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDist = path.join(__dirname, "../frontend/dist");

if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is required in .env to use the Gemini API.");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const GITHUB_JSON = "application/vnd.github.v3+json";
const MAX_RANGE_COMMITS = 500;
const MAX_RANGE_DIFF_CHARS = 280_000;
/** When compare(base...head) is unavailable (e.g. empty-tree base), cap per-commit fetches. */
const MAX_AGGREGATE_COMMIT_PATCHES = 100;

function githubHeaders(accept = GITHUB_JSON) {
  const headers = {
    Accept: accept,
    "User-Agent": "git-explain-app",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `token ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function fetchGithubDiff(commitSha, owner, repo) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${commitSha}`, {
    headers: githubHeaders("application/vnd.github.v3.diff"),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub API returned ${response.status}: ${response.statusText}${message ? ` - ${message}` : ""}`);
  }

  return await response.text();
}

/** Inclusive calendar range [startDate, endDate] as YYYY-MM-DD → GitHub `since` / `until` (until is exclusive). */
function toGithubSinceUntil(startDateStr, endDateStr) {
  const start = new Date(`${startDateStr}T00:00:00.000Z`);
  const endPlusOne = new Date(`${endDateStr}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(endPlusOne.getTime())) {
    throw new Error("Invalid date format. Use YYYY-MM-DD for start and end.");
  }
  endPlusOne.setUTCDate(endPlusOne.getUTCDate() + 1);
  if (endPlusOne <= start) {
    throw new Error("End date must be on or after the start date.");
  }
  return { sinceIso: start.toISOString(), untilIso: endPlusOne.toISOString() };
}

async function fetchGithubCommitsInRange(owner, repo, sinceIso, untilIso) {
  const commits = [];
  let page = 1;

  while (commits.length < MAX_RANGE_COMMITS) {
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/commits`);
    url.searchParams.set("since", sinceIso);
    url.searchParams.set("until", untilIso);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const response = await fetch(url, { headers: githubHeaders() });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`GitHub API returned ${response.status}: ${response.statusText}${message ? ` - ${message}` : ""}`);
    }

    const batch = await response.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    commits.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }

  if (commits.length >= MAX_RANGE_COMMITS) {
    throw new Error(
      `More than ${MAX_RANGE_COMMITS} commits in this range. Narrow the dates or raise the limit in the server.`
    );
  }

  commits.sort((a, b) => new Date(a.commit.committer.date) - new Date(b.commit.committer.date));
  return commits;
}

/**
 * GitHub returns 404 for unknown refs and for bases like the empty tree; callers should fall back.
 */
async function tryFetchGithubCompareDiff(baseSha, headSha, owner, repo) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`,
    { headers: githubHeaders("application/vnd.github.v3.diff") }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub compare failed ${response.status}: ${response.statusText}${message ? ` - ${message}` : ""}`);
  }

  return await response.text();
}

/**
 * Prefer one compare(parent_of_oldest...newest); on failure, concatenate per-commit patches (chronological).
 */
async function buildRangeDiff(commits, owner, repo) {
  if (commits.length === 0) {
    throw new Error("No commits to diff.");
  }

  const newest = commits[commits.length - 1];
  const headSha = newest.sha;

  if (commits.length === 1) {
    let diff = await fetchGithubDiff(commits[0].sha);
    let diffTruncated = false;
    if (diff.length > MAX_RANGE_DIFF_CHARS) {
      diff = diff.slice(0, MAX_RANGE_DIFF_CHARS);
      diffTruncated = true;
    }
    return {
      diff,
      diffTruncated,
      base_sha: commits[0].parents?.[0]?.sha ?? null,
      head_sha: commits[0].sha,
      diff_source: "commit_patch",
    };
  }

  const oldest = commits[0];
  const parentSha = oldest.parents?.[0]?.sha;

  if (parentSha) {
    const compared = await tryFetchGithubCompareDiff(parentSha, headSha, owner, repo);
    if (compared !== null) {
      let diff = compared;
      let diffTruncated = false;
      if (diff.length > MAX_RANGE_DIFF_CHARS) {
        diff = diff.slice(0, MAX_RANGE_DIFF_CHARS);
        diffTruncated = true;
      }
      return {
        diff,
        diffTruncated,
        base_sha: parentSha,
        head_sha: headSha,
        diff_source: "compare",
      };
    }
  }

  if (commits.length > MAX_AGGREGATE_COMMIT_PATCHES) {
    throw new Error(
      `GitHub compare is not available for this range (e.g. root commit or API limits), and this period has more than ${MAX_AGGREGATE_COMMIT_PATCHES} commits. Narrow the date range or set GITHUB_TOKEN for reliable access.`
    );
  }

  let combined = "";
  let diffTruncated = false;
  for (const c of commits) {
    const patch = await fetchGithubDiff(c.sha);
    const line = (c.commit?.message || "").split("\n")[0] || "";
    const block = `\n\n=== ${c.sha.slice(0, 7)} ${line.slice(0, 120)} ===\n${patch}`;
    if (combined.length + block.length > MAX_RANGE_DIFF_CHARS) {
      combined += block.slice(0, Math.max(0, MAX_RANGE_DIFF_CHARS - combined.length));
      diffTruncated = true;
      break;
    }
    combined += block;
  }

  return {
    diff: combined.trimStart(),
    diffTruncated,
    base_sha: parentSha ?? oldest.sha,
    head_sha: headSha,
    diff_source: "per_commit",
  };
}

function normalizeJsonText(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/```json\s*/gi, "").replace(/```$/, "");
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  return cleaned;
}

function parseModelJson(text) {
  const cleaned = normalizeJsonText(text);
  try {
    const parsed = JSON.parse(cleaned);
    return {
      summary: parsed.summary ?? parsed.description ?? text,
      key_changes: Array.isArray(parsed.key_changes) ? parsed.key_changes : [],
      risks: Array.isArray(parsed.risks) ? parsed.risks : [],
      impact: Array.isArray(parsed.impact) ? parsed.impact : [],
      raw: parsed,
    };
  } catch {
    return {
      summary: text,
      key_changes: [],
      risks: [],
      impact: [],
      raw: cleaned,
    };
  }
}

function buildPrompt({ diff, commitMessage, commitSha, repoOwner, repoName }) {
  return `You are an expert software engineer reviewing a git commit diff for quality, risk, and impact.

Use simple and clear language in your responses.

Return valid JSON only with the following keys:
- summary
- key_changes (array)
- risks (array)
- impact (array)

Commit SHA: ${commitSha || "N/A"}
Repository: ${repoOwner && repoName ? `${repoOwner}/${repoName}` : "N/A"}
Commit message: ${commitMessage || "N/A"}

DIFF:
${diff}
`;
}

function buildRangePrompt({
  diff,
  repoOwner,
  repoName,
  startDate,
  endDate,
  commitCount,
  commitSubjects,
  diffTruncated,
  diffSource,
}) {
  const subjectLines = commitSubjects.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const diffModeNote =
    diffSource === "per_commit"
      ? "The DIFF below concatenates individual commit patches in time order; the same lines may appear in multiple sections.\n"
      : diffSource === "commit_patch"
        ? "The DIFF is a single commit patch.\n"
        : "";

  return `You are an expert software engineer summarizing cumulative changes across multiple git commits for stakeholders.

Use simple and clear language. Focus on themes, user-visible behavior, and engineering risk across the whole period—not a per-commit list unless it helps clarity.

${diffModeNote}Return valid JSON only with the following keys:
- summary (string: overview of what changed in this period)
- key_changes (array: main themes or features touched)
- risks (array)
- impact (array)

Repository: ${repoOwner}/${repoName}
Date range (inclusive): ${startDate} through ${endDate}
Commits in range: ${commitCount}
${diffTruncated ? "Note: The diff below was truncated for length; mention uncertainty if the omitted parts could matter.\n" : ""}
Commit messages (oldest to newest):
${subjectLines}

DIFF (combined):
${diff}
`;
}

app.post("/api/summarize", async (req, res) => {
  try {
    const { diff: rawDiff, commitMessage, commitSha, repoOwner, repoName } = req.body;
    let diff = rawDiff?.trim() || "";

    if (!diff && commitSha) {
      if (!repoOwner || !repoName) {
        return res.status(400).json({ error: "Commit SHA requires repoOwner and repoName when a diff is not provided." });
      }
      diff = await fetchGithubDiff(commitSha, repoOwner, repoName);
    }

    if (!diff) {
      return res.status(400).json({ error: "Please provide a git diff or a commit SHA with repoOwner and repoName." });
    }

    const prompt = buildPrompt({ diff, commitMessage, commitSha, repoOwner, repoName });
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = await response.text();
    const payload = parseModelJson(text);

    res.json(payload);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Unexpected server error." });
  }
});

app.post("/api/summarize-range", async (req, res) => {
  try {
    const { repoOwner, repoName, startDate, endDate } = req.body;

    if (!repoOwner?.trim() || !repoName?.trim()) {
      return res.status(400).json({ error: "repoOwner and repoName are required." });
    }
    if (!startDate?.trim() || !endDate?.trim()) {
      return res.status(400).json({ error: "startDate and endDate are required (YYYY-MM-DD)." });
    }

    const owner = repoOwner.trim();
    const repo = repoName.trim();
    const { sinceIso, untilIso } = toGithubSinceUntil(startDate.trim(), endDate.trim());

    const commits = await fetchGithubCommitsInRange(owner, repo, sinceIso, untilIso);
    if (commits.length === 0) {
      return res.status(404).json({
        error:
          "No commits found in that date range for the default branch. Try different dates or ensure the repo has activity.",
      });
    }

    const { diff, diffTruncated, base_sha: baseSha, head_sha: headSha, diff_source: diffSource } = await buildRangeDiff(
      commits,
      owner,
      repo
    );

    const commitSubjects = commits.map((c) => (c.commit?.message || "").split("\n")[0].slice(0, 200));
    const prompt = buildRangePrompt({
      diff,
      repoOwner: owner,
      repoName: repo,
      startDate: startDate.trim(),
      endDate: endDate.trim(),
      commitCount: commits.length,
      commitSubjects,
      diffTruncated,
      diffSource,
    });

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(prompt);
    const responseText = await result.response.text();
    const payload = parseModelJson(responseText);

    res.json({
      ...payload,
      meta: {
        commit_count: commits.length,
        start_date: startDate.trim(),
        end_date: endDate.trim(),
        base_sha: baseSha,
        head_sha: headSha,
        diff_truncated: diffTruncated,
        diff_source: diffSource,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Unexpected server error." });
  }
});

if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.use((req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

app.listen(8000, () => {
  console.log("Server running on http://localhost:8000");
});
