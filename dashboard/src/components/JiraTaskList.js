import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";

function StatusPill({ status }) {
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-slate-700 text-slate-300">
      {status}
    </span>
  );
}

export default function JiraTaskList({
  pipelines,
  onStartPipeline,
  onStarted,
}) {
  const [jiraStatus, setJiraStatus] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [startingKey, setStartingKey] = useState(null);
  const [error, setError] = useState(null);
  const [jql, setJql] = useState("");

  const activeKeys = new Set(
    (pipelines || [])
      .filter(
        (p) => !["gate_1_rejected", "failed", "completed"].includes(p.status),
      )
      .map((p) => p.jira_key?.toUpperCase()),
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const status = await api.jiraStatus();
      setJiraStatus(status);

      if (!status.configured || !status.connected) {
        setTasks([]);
        return;
      }

      const result = await api.jiraTasks({ jql: jql || undefined, limit: 30 });
      setTasks(result.issues || []);
    } catch (err) {
      setError(err.message);
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, [jql]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleStart(key) {
    setStartingKey(key);
    setError(null);
    try {
      const { pipeline } = await api.createPipelineFromJira(key);
      onStarted?.(pipeline);
      onStartPipeline?.(pipeline);
    } catch (err) {
      setError(err.message);
    } finally {
      setStartingKey(null);
    }
  }

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/60 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">
            Live Jira Tasks
          </h2>
          {jiraStatus && (
            <p className="text-xs mt-0.5 text-slate-500">
              {jiraStatus.connected
                ? `Connected as ${jiraStatus.account}`
                : jiraStatus.configured
                  ? "Configured but not connected"
                  : "Not configured — set JIRA_* in backend/.env"}
            </p>
          )}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-xs rounded-lg border border-slate-600 px-2.5 py-1.5 hover:bg-slate-800 disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {jiraStatus?.connected && (
        <div className="px-4 py-2 border-b border-slate-800">
          <input
            value={jql}
            onChange={(e) => setJql(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
            placeholder='JQL filter (optional) e.g. status = "To Do"'
            className="w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      )}

      <div className="max-h-96 overflow-y-auto">
        {loading && (
          <p className="p-4 text-sm text-slate-500">Loading Jira tasks…</p>
        )}

        {!loading && error && (
          <p className="p-4 text-sm text-red-400">{error}</p>
        )}

        {!loading && !error && jiraStatus && !jiraStatus.connected && (
          <p className="p-4 text-sm text-slate-500">
            Add Jira credentials to{" "}
            <code className="text-slate-400">backend/.env</code> and restart the
            API.
          </p>
        )}

        {!loading && !error && tasks.length === 0 && jiraStatus?.connected && (
          <p className="p-4 text-sm text-slate-500">
            No tasks found for current JQL.
          </p>
        )}

        {tasks.map((task) => {
          const inPipeline = activeKeys.has(task.jira_key?.toUpperCase());
          return (
            <div
              key={task.jira_key}
              className="px-4 py-3 border-b border-slate-800 last:border-0 hover:bg-slate-800/40"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <a
                      href={task.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-sm text-blue-300 hover:underline"
                    >
                      {task.jira_key}
                    </a>
                    <StatusPill status={task.status} />
                    <span className="text-[10px] text-slate-500">
                      {task.issue_type}
                    </span>
                  </div>
                  <p className="text-sm text-slate-200 mt-1 truncate">
                    {task.summary}
                  </p>
                  {task.assignee && (
                    <p className="text-xs text-slate-500 mt-0.5">
                      {task.assignee}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => handleStart(task.jira_key)}
                  disabled={inPipeline || startingKey === task.jira_key}
                  className="shrink-0 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1.5 text-xs font-medium"
                >
                  {inPipeline
                    ? "In pipeline"
                    : startingKey === task.jira_key
                      ? "Starting…"
                      : "Start"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
