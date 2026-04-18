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

async function fetchGithubDiff(commitSha, owner, repo) {
  const headers = {
    Accept: "application/vnd.github.v3.diff",
    "User-Agent": "git-explain-app",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `token ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${commitSha}`, {
    headers,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub API returned ${response.status}: ${response.statusText}${message ? ` - ${message}` : ""}`);
  }

  return await response.text();
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

if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.use((req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

app.listen(8000, () => {
  console.log("Server running on http://localhost:8000");
});
