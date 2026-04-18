import { useState } from "react";

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
  const [response, setResponse] = useState(emptyResponse);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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
      const result = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await result.json();
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
      setError(err.message || "Unexpected error reaching the API.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">AI-powered commit briefing</p>
          <h1>Github Commit Summary</h1>
          <p>
            Generate concise, stakeholder-ready commit summaries with risks,
            impact, and key changes in a single click.
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
              Commit SHA
              <input
                value={commitSha}
                onChange={(event) => setCommitSha(event.target.value)}
                placeholder="abc123def456"
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
    </main>
  );
}

export default App;
