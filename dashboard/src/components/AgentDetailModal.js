import { getAgentDetail } from "../lib/agent-details.js";

function JsonBlock({ data }) {
  if (!data) return <p className="text-slate-500 italic">No output yet.</p>;
  return (
    <pre className="text-xs text-slate-300 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed max-h-[60vh]">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function CodeFilesBlock({ codeBundle }) {
  const files = codeBundle?.files || [];
  const edits = codeBundle?.edits || [];

  if (!files.length && !edits.length) {
    return <p className="text-slate-500 italic">No code generated yet.</p>;
  }

  return (
    <div className="space-y-4 max-h-[60vh] overflow-y-auto">
      {edits.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wider text-slate-500 mb-2">Patch edits</p>
          <pre className="text-xs text-slate-300 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed rounded-lg border border-slate-700 p-3">
            {JSON.stringify(edits, null, 2)}
          </pre>
        </div>
      )}
      {files.map((file) => (
        <div key={file.path} className="rounded-lg border border-slate-700 overflow-hidden">
          <div className="px-3 py-1.5 bg-slate-800 text-xs font-mono text-blue-300">
            {file.path}
          </div>
          <pre className="p-3 text-xs text-slate-300 overflow-x-auto max-h-64 whitespace-pre-wrap">
            {file.content}
          </pre>
        </div>
      ))}
    </div>
  );
}

function GateBlock({ data }) {
  if (!data) return <p className="text-slate-500 italic">Gate not reached yet.</p>;

  return (
    <div className="space-y-3 text-sm">
      <p className="text-slate-300">
        Status:{" "}
        <span className="font-mono text-slate-100">
          {data.approved === true
            ? "approved"
            : data.approved === false
              ? "rejected"
              : data.status || "pending"}
        </span>
      </p>
      {data.feedback && (
        <div>
          <p className="text-xs uppercase tracking-wider text-slate-500 mb-1">Feedback</p>
          <p className="text-slate-300 whitespace-pre-wrap">{data.feedback}</p>
        </div>
      )}
      {data.merge_request?.web_url && (
        <p>
          <a
            href={data.merge_request.web_url}
            target="_blank"
            rel="noreferrer"
            className="text-sky-400 hover:text-sky-300 underline text-sm"
          >
            Open merge request
          </a>
        </p>
      )}
    </div>
  );
}

function ClarifyBlock({ data }) {
  if (!data) return <p className="text-slate-500 italic">No clarification needed.</p>;

  return (
    <div className="space-y-3 text-sm max-h-[60vh] overflow-y-auto">
      {data.repo_path && (
        <p className="text-slate-400 text-xs">
          Repo: <span className="font-mono text-slate-300">{data.repo_path}</span>
        </p>
      )}
      {data.issues?.length > 0 && (
        <ul className="text-slate-300 list-disc pl-4 space-y-1">
          {data.issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
        </ul>
      )}
      {data.edit_targets?.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wider text-slate-500 mb-1">Suggested targets</p>
          <ul className="font-mono text-xs text-slate-300 space-y-1">
            {data.edit_targets.map((t) => (
              <li key={t.path}>
                {t.path}
                {t.exists === false ? " (missing)" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.matched_files?.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wider text-slate-500 mb-1">Matched files</p>
          <ul className="font-mono text-xs text-slate-400 space-y-1">
            {data.matched_files.map((f) => (
              <li key={f.path}>
                {f.path}
                {f.match_type ? ` · ${f.match_type}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const STATE_LABEL = {
  done: "Completed",
  active: "Running",
  waiting: "Awaiting approval",
  rejected: "Rejected",
  pending: "Pending",
  skipped: "Skipped",
};

export default function AgentDetailModal({ pipeline, agentId, onClose }) {
  if (!agentId) return null;

  const detail = getAgentDetail(pipeline, agentId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-3xl max-h-[90vh] overflow-hidden rounded-2xl border border-white/10 bg-slate-950 shadow-2xl shadow-cyan-500/10 flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-modal-title"
      >
        <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-white/[0.06] bg-gradient-to-r from-slate-900/80 to-slate-950">
          <div>
            <h2 id="agent-modal-title" className="text-lg font-semibold text-slate-100">
              {detail.title}
              {detail.subtitle ? `: ${detail.subtitle}` : ""}
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              {STATE_LABEL[detail.state] || detail.state}
              {detail.log?.output_summary ? ` · ${detail.log.output_summary}` : ""}
            </p>
            {detail.log?.completed_at && (
              <p className="text-xs text-slate-500 mt-0.5">
                Finished {new Date(detail.log.completed_at).toLocaleString()}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 text-xl leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="p-5 overflow-y-auto flex-1">
          {detail.state === "active" && !detail.data && (
            <p className="text-sm text-blue-300 mb-4">Agent is running via Ollama…</p>
          )}
          {detail.kind === "json" && <JsonBlock data={detail.data} />}
          {detail.kind === "code" && <CodeFilesBlock codeBundle={detail.data} />}
          {detail.kind === "gate" && <GateBlock data={detail.data} />}
          {detail.kind === "clarify" && <ClarifyBlock data={detail.data} />}
        </div>
      </div>
    </div>
  );
}
