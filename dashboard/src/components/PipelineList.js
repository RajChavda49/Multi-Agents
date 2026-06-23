import StatusBadge from "./StatusBadge.js";
import AgentTimeline from "./AgentTimeline.js";

export default function PipelineList({ pipelines, selectedId, onSelect }) {
  if (!pipelines.length) {
    return (
      <div className="rounded-xl border border-dashed border-slate-700 p-8 text-center text-slate-500 text-sm">
        No pipelines yet. Create one from a Jira task or use the CLI.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {pipelines.map((p) => (
        <button
          key={p.id}
          onClick={() => onSelect(p.id)}
          className={`w-full text-left rounded-xl border p-4 transition-colors ${
            selectedId === p.id
              ? "border-blue-500 bg-blue-950/20"
              : "border-slate-700 bg-slate-900/40 hover:border-slate-500"
          }`}
        >
          <div className="flex items-center justify-between gap-3 mb-2">
            <span className="font-mono text-sm text-blue-300">{p.jira_key}</span>
            <StatusBadge status={p.status} />
          </div>
          <p className="text-sm text-slate-200 truncate">{p.summary}</p>
          <p className="text-xs text-slate-500 mt-2">
            Updated {new Date(p.updated_at).toLocaleString()}
          </p>
        </button>
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
