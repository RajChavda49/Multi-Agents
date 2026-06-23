import { useState } from "react";
import { api } from "../api.js";

export default function CreatePipelineForm({ onCreated, jiraConnected }) {
  const [key, setKey] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [fetchFromJira, setFetchFromJira] = useState(jiraConnected);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      let pipeline;

      if (fetchFromJira && jiraConnected && key && !summary) {
        ({ pipeline } = await api.createPipelineFromJira(key));
      } else {
        ({ pipeline } = await api.createPipeline({
          jira_key: key,
          summary,
          description,
          fetch_from_jira: fetchFromJira && jiraConnected,
        }));
      }

      onCreated(pipeline);
      setKey("");
      setSummary("");
      setDescription("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const jiraOnlyMode = fetchFromJira && jiraConnected;

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-slate-700 bg-slate-900/60 p-5 space-y-4">
      <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">
        New Pipeline
      </h2>

      {jiraConnected && (
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={fetchFromJira}
            onChange={(e) => setFetchFromJira(e.target.checked)}
            className="rounded border-slate-600"
          />
          Fetch live details from Jira API
        </label>
      )}

      <label className="block">
        <span className="text-xs text-slate-400">Jira Key</span>
        <input
          required
          value={key}
          onChange={(e) => setKey(e.target.value.toUpperCase())}
          placeholder="PROJ-123"
          className="mt-1 w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </label>

      {!jiraOnlyMode && (
        <>
          <label className="block">
            <span className="text-xs text-slate-400">Summary</span>
            <input
              required={!jiraOnlyMode}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Add user profile page"
              className="mt-1 w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>

          <label className="block">
            <span className="text-xs text-slate-400">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Acceptance criteria, links, context..."
              className="mt-1 w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
            />
          </label>
        </>
      )}

      {jiraOnlyMode && (
        <p className="text-xs text-slate-500">
          Summary and description will be pulled from Jira when the pipeline starts.
        </p>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2 text-sm font-medium transition-colors"
      >
        {loading ? "Running A1 → A2 → A3…" : "Start Phase 1 Pipeline"}
      </button>
    </form>
  );
}
