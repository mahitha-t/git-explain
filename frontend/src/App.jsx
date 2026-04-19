import { useEffect, useState } from "react";

/** Empty = same origin (Vite proxy to :8000 in dev, or Express serving dist in prod). Set VITE_API_BASE_URL for other hosts (e.g. deployed API). */
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

function apiUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return API_BASE ? `${API_BASE}${p}` : p;
}

function formatApiError(err) {
  const msg = err?.message ?? String(err);
  if (msg === "Failed to fetch" || msg.includes("NetworkError") || msg.includes("CONNECTION_REFUSED")) {
    return "Cannot reach the API (connection refused). Start the backend on port 8000, or from the repo root run: npm install && npm run dev";
  }
  return msg || "Unexpected error reaching the API.";
}

async function parseApiJsonResponse(result) {
  const contentType = result.headers.get("content-type") || "";
  const text = await result.text();

  if (!contentType.includes("application/json")) {
    throw new Error(`API returned non-JSON (status ${result.status}). Check deployment routing and API path.`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`API returned invalid JSON (status ${result.status}).`);
  }
}

const emptyResponse = {
  summary: "",
  key_changes: [],
  risks: [],
  impact: [],
};

function App() {
  const [commitSha, setCommitSha] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [repoOwner, setRepoOwner] = useState("");
  const [repoName, setRepoName] = useState("");
  const [commitOptions, setCommitOptions] = useState([]);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsError, setCommitsError] = useState("");
  const [commitsTruncated, setCommitsTruncated] = useState(false);
  const [response, setResponse] = useState(emptyResponse);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [rangeResponse, setRangeResponse] = useState(emptyResponse);
  const [rangeMeta, setRangeMeta] = useState(null);
  const [rangeStatus, setRangeStatus] = useState("");
  const [rangeError, setRangeError] = useState("");
  const [rangeLoading, setRangeLoading] = useState(false);

  useEffect(() => {
    const owner = repoOwner.trim();
    const repo = repoName.trim();

    if (!owner || !repo) {
      setCommitOptions([]);
      setCommitsError("");
      setCommitsTruncated(false);
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(async () => {
      setCommitsLoading(true);
      setCommitsError("");
      setCommitsTruncated(false);
      try {
        const params = new URLSearchParams({ repoOwner: owner, repoName: repo });
        const result = await fetch(apiUrl(`/api/commits?${params.toString()}`), {
          signal: controller.signal,
        });
        const data = await parseApiJsonResponse(result);
        if (!result.ok) {
          setCommitOptions([]);
          setCommitsError(data.error || "Unable to fetch commits for this repository.");
          return;
        }

        const options = Array.isArray(data.commits) ? data.commits : [];
        setCommitOptions(options);
        setCommitsTruncated(Boolean(data.truncated));

        if (options.length === 0) {
          setCommitSha("");
          return;
        }

        const hasSelected = options.some((item) => item.sha === commitSha);
        if (!hasSelected) {
          setCommitSha(options[0].sha);
          if (!commitMessage.trim()) {
            setCommitMessage(options[0].message || "");
          }
        }
      } catch (err) {
        if (err?.name === "AbortError") return;
        setCommitOptions([]);
        setCommitsError(formatApiError(err));
      } finally {
        setCommitsLoading(false);
      }
    }, 350);

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [repoOwner, repoName]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setStatus("");
    setResponse(emptyResponse);

    if (!commitSha.trim()) {
      setError("Provide a commit SHA with repo owner and name.");
      return;
    }

    if (!repoOwner.trim() || !repoName.trim()) {
      setError("Repo owner and repo name are required.");
      return;
    }

    const payload = {
      commitSha: commitSha.trim(),
      commitMessage: commitMessage.trim(),
      repoOwner: repoOwner.trim(),
      repoName: repoName.trim(),
    };

    setLoading(true);
    setStatus("Generating summary...");

    try {
      const result = await fetch(apiUrl("/api/summarize"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await parseApiJsonResponse(result);
      if (!result.ok) {
        setError(data.error || "Unable to generate summary.");
      } else {
        setResponse({
          summary: data.summary || "No summary returned.",
          key_changes: Array.isArray(data.key_changes) ? data.key_changes : [],
          risks: Array.isArray(data.risks) ? data.risks : [],
          impact: Array.isArray(data.impact) ? data.impact : [],
        });
        setStatus("Summary complete.");
      }
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleRangeSubmit = async (event) => {
    event.preventDefault();
    setRangeError("");
    setRangeStatus("");
    setRangeResponse(emptyResponse);
    setRangeMeta(null);

    if (!repoOwner.trim() || !repoName.trim()) {
      setRangeError("Repo owner and repo name are required.");
      return;
    }
    if (!rangeStart.trim() || !rangeEnd.trim()) {
      setRangeError("Choose a start and end date (inclusive).");
      return;
    }

    const payload = {
      repoOwner: repoOwner.trim(),
      repoName: repoName.trim(),
      startDate: rangeStart.trim(),
      endDate: rangeEnd.trim(),
    };

    setRangeLoading(true);
    setRangeStatus("Fetching commits and generating summary…");

    try {
      const result = await fetch(apiUrl("/api/summarize-range"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await parseApiJsonResponse(result);
      if (!result.ok) {
        setRangeError(data.error || "Unable to summarize this range.");
      } else {
        setRangeResponse({
          summary: data.summary || "No summary returned.",
          key_changes: Array.isArray(data.key_changes) ? data.key_changes : [],
          risks: Array.isArray(data.risks) ? data.risks : [],
          impact: Array.isArray(data.impact) ? data.impact : [],
        });
        setRangeMeta(data.meta ?? null);
        setRangeStatus("Range summary complete.");
      }
    } catch (err) {
      setRangeError(formatApiError(err));
    } finally {
      setRangeLoading(false);
    }
  };

  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Smart Commit Briefing</p>
          <h1>Git the Gist</h1>
          <p>
            Generate concise, stakeholder-ready commit summaries—or roll up every
            commit in a date range into one briefing with risks, impact, and key
            themes.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Commit details</p>
            <h2>Summarize a commit</h2>
            <p className="panel-description">
              Provide the commit SHA and repository details to produce a clear,
              professional summary for release notes or review meetings.
            </p>
          </div>
        </div>

        <form className="form" onSubmit={handleSubmit}>
          <div className="grid-two">
            <label>
              GitHub repo owner
              <input
                value={repoOwner}
                onChange={(event) => setRepoOwner(event.target.value)}
                placeholder="owner"
              />
            </label>
            <label>
              GitHub repo name
              <input
                value={repoName}
                onChange={(event) => setRepoName(event.target.value)}
                placeholder="repository"
              />
            </label>
          </div>

          <div className="status-row">
            {commitsLoading && <div className="status">Loading commits...</div>}
            {commitsError && <div className="error">{commitsError}</div>}
            {!commitsLoading && !commitsError && commitsTruncated && (
              <div className="status">Showing the newest 300 commits for this repository.</div>
            )}
          </div>

          <div className="grid-two">
            <label>
              Commit SHA
              <select
                value={commitSha}
                onChange={(event) => {
                  const sha = event.target.value;
                  setCommitSha(sha);
                  const selected = commitOptions.find((item) => item.sha === sha);
                  if (selected && !commitMessage.trim()) {
                    setCommitMessage(selected.message || "");
                  }
                }}
                disabled={!repoOwner.trim() || !repoName.trim() || commitsLoading || commitOptions.length === 0}
              >
                <option value="">
                  {!repoOwner.trim() || !repoName.trim()
                    ? "Enter repo owner and name first"
                    : commitsLoading
                      ? "Loading commits..."
                      : commitOptions.length === 0
                        ? "No commits found"
                        : "Select a commit"}
                </option>
                {commitOptions.map((item) => (
                  <option key={item.sha} value={item.sha}>
                    {item.short_sha} - {item.message || "(no commit message)"}
                  </option>
                ))}
              </select>
              <input
                value={commitSha}
                onChange={(event) => setCommitSha(event.target.value)}
                placeholder="Or paste a full SHA manually"
                style={{ marginTop: "0.5rem" }}
              />
            </label>
            <label>
              Commit message
              <input
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="Fix auth validation on signup"
              />
            </label>
          </div>

          <div className="actions">
            <button type="submit" disabled={loading}>
              {loading ? "Summarizing…" : "Generate summary"}
            </button>
          </div>
        </form>

        <div className="status-row">
          {status && <div className="status">{status}</div>}
          {error && <div className="error">{error}</div>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Release notes</p>
            <h2>Summarize updates in a date range</h2>
            <p className="panel-description">
              Uses the repository&apos;s default branch. Dates are inclusive (UTC
              calendar days). A GitHub token in the server environment is
              recommended for private repos and higher rate limits.
            </p>
          </div>
        </div>

        <form className="form" onSubmit={handleRangeSubmit}>
          <div className="grid-two">
            <label>
              Start date
              <input
                type="date"
                value={rangeStart}
                onChange={(event) => setRangeStart(event.target.value)}
              />
            </label>
            <label>
              End date
              <input
                type="date"
                value={rangeEnd}
                onChange={(event) => setRangeEnd(event.target.value)}
              />
            </label>
          </div>

          <p className="panel-description" style={{ margin: 0 }}>
            Repo: use the same owner and name as in the section above.
          </p>

          <div className="actions">
            <button type="submit" disabled={rangeLoading}>
              {rangeLoading ? "Summarizing range…" : "Summarize date range"}
            </button>
          </div>
        </form>

        <div className="status-row">
          {rangeStatus && <div className="status">{rangeStatus}</div>}
          {rangeError && <div className="error">{rangeError}</div>}
        </div>
      </section>

      {response.summary && (
        <section className="result">
          <div className="card full">
            <div className="result-heading">
              <h2>Summary</h2>
              <p>Review the AI-generated briefing before sharing or saving.</p>
            </div>
            <p>{response.summary}</p>
          </div>

          <div className="grid-cards">
            <div className="card section-card">
              <h3>Key changes</h3>
              <div className="section-list">
                {response.key_changes.length > 0 ? (
                  response.key_changes.map((item, idx) => (
                    <p key={idx}>• {item}</p>
                  ))
                ) : (
                  <p>• No detected key changes.</p>
                )}
              </div>
            </div>

            <div className="card section-card">
              <h3>Risks</h3>
              <div className="section-list">
                {response.risks.length > 0 ? (
                  response.risks.map((item, idx) => (
                    <p key={idx}>• {item}</p>
                  ))
                ) : (
                  <p>• No significant risks detected.</p>
                )}
              </div>
            </div>

            <div className="card section-card">
              <h3>Impact</h3>
              <div className="section-list">
                {response.impact.length > 0 ? (
                  response.impact.map((item, idx) => (
                    <p key={idx}>• {item}</p>
                  ))
                ) : (
                  <p>• No impact items generated.</p>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {rangeResponse.summary && (
        <section className="result">
          <div className="card full">
            <div className="result-heading">
              <h2>Range summary</h2>
              <p>
                {rangeMeta
                  ? `${rangeMeta.commit_count} commit${rangeMeta.commit_count === 1 ? "" : "s"} · ${rangeMeta.start_date} → ${rangeMeta.end_date}${
                      rangeMeta.diff_truncated ? " · diff truncated for length" : ""
                    }${rangeMeta.diff_source === "per_commit" ? " · combined from per-commit patches" : ""}`
                  : "AI briefing for the selected period."}
              </p>
            </div>
            <p>{rangeResponse.summary}</p>
          </div>

          <div className="grid-cards">
            <div className="card section-card">
              <h3>Key changes</h3>
              <div className="section-list">
                {rangeResponse.key_changes.length > 0 ? (
                  rangeResponse.key_changes.map((item, idx) => (
                    <p key={idx}>• {item}</p>
                  ))
                ) : (
                  <p>• No detected key changes.</p>
                )}
              </div>
            </div>

            <div className="card section-card">
              <h3>Risks</h3>
              <div className="section-list">
                {rangeResponse.risks.length > 0 ? (
                  rangeResponse.risks.map((item, idx) => (
                    <p key={idx}>• {item}</p>
                  ))
                ) : (
                  <p>• No significant risks detected.</p>
                )}
              </div>
            </div>

            <div className="card section-card">
              <h3>Impact</h3>
              <div className="section-list">
                {rangeResponse.impact.length > 0 ? (
                  rangeResponse.impact.map((item, idx) => (
                    <p key={idx}>• {item}</p>
                  ))
                ) : (
                  <p>• No impact items generated.</p>
                )}
              </div>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}

export default App;
