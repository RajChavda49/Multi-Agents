import { useState } from "react";
import StatusBadge from "./StatusBadge.js";
import AgentTimeline from "./AgentTimeline.js";
import { formatRunningLabel, runningAgents } from "../lib/agent-details.js";

export default function PipelineList({ pipelines, selectedId, onSelect, onDelete }) {
  const [deletingId, setDeletingId] = useState(null);

  async function handleDelete(e, pipeline) {
    e.stopPropagation();
    const label = `${pipeline.jira_key} — ${pipeline.summary}`;
    if (!window.confirm(`Delete pipeline for ${label}?\n\nYou can start a fresh run from Jira after this.`)) {
      return;
    }

    setDeletingId(pipeline.id);
    try {
      await onDelete?.(pipeline.id);
    } catch (err) {
      window.alert(err.message || "Failed to delete pipeline");
    } finally {
      setDeletingId(null);
    }
  }

  if (!pipelines.length) {
    return (
      <div className="rounded-xl border border-dashed border-slate-700 p-8 text-center text-slate-500 text-sm">
        No pipelines yet. Create one from a Jira task or use the CLI.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider px-1">
        Pipelines ({pipelines.length})
      </h2>
      {pipelines.map((p) => (
        <div
          key={p.id}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(p.id)}
          onKeyDown={(e) => e.key === "Enter" && onSelect(p.id)}
          className={`w-full text-left rounded-xl border p-4 transition-colors cursor-pointer ${
            selectedId === p.id
              ? "border-blue-500 bg-blue-950/20"
              : "border-slate-700 bg-slate-900/40 hover:border-slate-500"
          }`}
        >
          <div className="flex items-center justify-between gap-3 mb-2">
            <span className="font-mono text-sm text-blue-300">{p.jira_key}</span>
            <div className="flex items-center gap-2">
              <StatusBadge status={p.status} />
              <button
                type="button"
                onClick={(e) => handleDelete(e, p)}
                disabled={deletingId === p.id}
                className="text-xs rounded-lg border border-red-900/60 text-red-400 hover:bg-red-950/40 px-2 py-1 disabled:opacity-50"
                title="Delete pipeline"
              >
                {deletingId === p.id ? "…" : "Delete"}
              </button>
            </div>
          </div>
          <p className="text-sm text-slate-200 truncate">{p.summary}</p>
          {["phase_1_running", "phase_2_running"].includes(p.status) &&
            (runningAgents(p).length > 0 || p.phase_2_substatus === "writing_code") && (
            <p className="text-xs text-blue-300 mt-1">{formatRunningLabel(p)}</p>
          )}
          {p.status === "failed" && p.error && (
            <p className="text-xs text-red-400 mt-1 truncate" title={p.error}>
              {p.failed_agent ? `${p.failed_agent}: ` : ""}
              {p.error}
            </p>
          )}
          <p className="text-xs text-slate-500 mt-2">
            Updated {new Date(p.updated_at).toLocaleString()}
          </p>
        </div>
      ))}
    </div>
  );
}

export function PipelineListCompact({ pipeline }) {
  if (!pipeline) return null;
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-4">
      <AgentTimeline pipeline={pipeline} />
    </div>
  );
}
