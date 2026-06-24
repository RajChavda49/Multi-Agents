import { useState } from "react";
import StatusBadge from "./StatusBadge.js";
import AgentTimeline from "./AgentTimeline.js";
import { api } from "../api.js";

function Section({ title, children }) {
  return (
    <section className="rounded-xl border border-slate-700 bg-slate-900/40 overflow-hidden">
      <div className="px-4 py-2 border-b border-slate-700 bg-slate-800/50">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h3>
      </div>
      <div className="p-4 text-sm">{children}</div>
    </section>
  );
}

function JsonBlock({ data }) {
  if (!data) return <p className="text-slate-500 italic">Not generated yet.</p>;
  return (
    <pre className="text-xs text-slate-300 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed max-h-96">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function CodeFilesBlock({ codeBundle, label }) {
  if (!codeBundle?.files?.length) {
    return <p className="text-slate-500 italic">No {label} files yet.</p>;
  }
  return (
    <div className="space-y-3">
      {codeBundle.files.map((file) => (
        <div key={file.path} className="rounded-lg border border-slate-700 overflow-hidden">
          <div className="px-3 py-1.5 bg-slate-800 text-xs font-mono text-blue-300">{file.path}</div>
          <pre className="p-3 text-xs text-slate-300 overflow-x-auto max-h-48">{file.content}</pre>
        </div>
      ))}
    </div>
  );
}

function GatePanel({ title, description, feedback, setFeedback, loading, onApprove, onReject }) {
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-950/30 p-5 space-y-3">
      <p className="text-amber-200 font-medium">{title}</p>
      <p className="text-xs text-amber-200/70">{description}</p>
      <textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="Optional feedback..."
        rows={2}
        className="w-full rounded-lg bg-slate-900 border border-slate-600 px-3 py-2 text-sm"
      />
      <div className="flex gap-3">
        <button
          onClick={onApprove}
          disabled={loading}
          className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-2 text-sm font-medium"
        >
          Approve
        </button>
        <button
          onClick={onReject}
          disabled={loading}
          className="rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-50 px-4 py-2 text-sm font-medium"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

export default function PipelineDetail({ pipeline, onUpdate, onBack, onDelete }) {
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  async function handleDelete() {
    const label = `${pipeline.jira_task?.key} — ${pipeline.jira_task?.summary}`;
    if (!window.confirm(`Delete pipeline for ${label}?`)) return;

    setDeleting(true);
    setError(null);
    try {
      await onDelete?.(pipeline.id);
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  }

  async function runGate(action) {
    setLoading(true);
    setError(null);
    try {
      const { pipeline: updated } = await action();
      onUpdate(updated);
      setFeedback("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const awaitingGate1 = pipeline.status === "awaiting_gate_1";
  const awaitingGate2 = pipeline.status === "awaiting_gate_2";
  const showGeneratedCode = Boolean(pipeline.frontend_code);
  const showPostGate2 =
    pipeline.status === "phase_2_complete" ||
    pipeline.code_review ||
    pipeline.test_execution ||
    pipeline.execution_report;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <button onClick={onBack} className="text-xs text-slate-400 hover:text-slate-200 mb-2">
            ← Back to pipelines
          </button>
          <h2 className="text-xl font-semibold">
            {pipeline.jira_task?.key} — {pipeline.jira_task?.summary}
          </h2>
          <p className="text-sm text-slate-400 mt-1">{pipeline.jira_task?.description}</p>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={pipeline.status} />
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting || loading}
            className="text-xs rounded-lg border border-red-900/60 text-red-400 hover:bg-red-950/40 px-3 py-1.5 disabled:opacity-50"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-950/50 border border-red-800 text-red-300 text-sm px-4 py-2">
          {error}
        </div>
      )}

      <AgentTimeline pipeline={pipeline} />

      {(pipeline.git_branch || pipeline.git_publish?.merge_request) && (
        <Section title="Git / GitLab">
          {pipeline.git_branch && (
            <p className="text-sm text-slate-300">
              Branch: <code className="text-sky-300">{pipeline.git_branch}</code>
              {pipeline.repo_source && (
                <span className="text-slate-500"> · source: {pipeline.repo_source}</span>
              )}
            </p>
          )}
          {pipeline.git_publish?.merge_request?.web_url && (
            <p className="text-sm mt-2">
              <a
                href={pipeline.git_publish.merge_request.web_url}
                target="_blank"
                rel="noreferrer"
                className="text-sky-400 hover:text-sky-300 underline"
              >
                Open merge request
              </a>
            </p>
          )}
          {pipeline.git_publish?.error && (
            <p className="text-sm text-red-400 mt-2">Publish failed: {pipeline.git_publish.error}</p>
          )}
        </Section>
      )}

      {awaitingGate1 && (
        <GatePanel
          title="🛑 Gate 1 — Review Spec & Test Plan"
          description="Approve to start Phase 2: A4/A5/A6 will generate code & test scripts, then pause at Gate 2 for your review."
          feedback={feedback}
          setFeedback={setFeedback}
          loading={loading}
          onApprove={() =>
            runGate(() => api.approveGate1(pipeline.id, feedback || undefined))
          }
          onReject={() =>
            runGate(() => api.rejectGate1(pipeline.id, feedback || "Rejected from dashboard"))
          }
        />
      )}

      {awaitingGate2 && (
        <GatePanel
          title="🛑 Gate 2 — Review Generated Code & Test Scripts"
          description="Review the frontend, backend, and Playwright test code below. Approve to run automated review (A7), test execution (A8), and reporting (A9). Reject to stop the pipeline."
          feedback={feedback}
          setFeedback={setFeedback}
          loading={loading}
          onApprove={() =>
            runGate(() => api.approveGate2(pipeline.id, feedback || undefined))
          }
          onReject={() =>
            runGate(() => api.rejectGate2(pipeline.id, feedback || "Rejected from dashboard"))
          }
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="A1 — Knowledge Context">
          <JsonBlock data={pipeline.knowledge_context} />
        </Section>
        <Section title="A2 — Technical Spec">
          <JsonBlock data={pipeline.technical_spec} />
        </Section>
      </div>

      <Section title={`A3 — Test Cases${pipeline.test_suite_name ? `: ${pipeline.test_suite_name}` : ""}`}>
        <JsonBlock data={pipeline.test_cases} />
      </Section>

      {showGeneratedCode && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Section title="A4 — Frontend Code">
              <CodeFilesBlock codeBundle={pipeline.frontend_code} label="frontend" />
            </Section>
            <Section title="A5 — Backend Code">
              <CodeFilesBlock codeBundle={pipeline.backend_code} label="backend" />
            </Section>
            <Section title="A6 — Test Code">
              <CodeFilesBlock codeBundle={pipeline.test_code} label="test" />
            </Section>
          </div>

          {pipeline.workspace_files?.length > 0 && (
            <Section title="Workspace Files">
              <ul className="text-xs font-mono text-slate-400 space-y-1">
                {pipeline.workspace_files.map((f) => (
                  <li key={f.path}>
                    {f.path} <span className="text-slate-600">({f.size} bytes)</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}

      {showPostGate2 && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Section title="A7 — Code Review">
              <JsonBlock data={pipeline.code_review} />
            </Section>
            <Section title="A8 — Test Execution">
              <JsonBlock data={pipeline.test_execution} />
            </Section>
          </div>

          <Section title="A9 — Execution Report">
            <JsonBlock data={pipeline.execution_report} />
          </Section>
        </>
      )}

      {pipeline.agent_logs?.length > 0 && (
        <Section title="Agent Logs">
          <ul className="space-y-2">
            {pipeline.agent_logs.map((log, i) => (
              <li key={i} className="flex gap-3 text-xs font-mono text-slate-400">
                <span className="text-slate-500">{log.agent}</span>
                <span className="text-slate-300">{log.name}</span>
                <span>{log.status}</span>
                <span className="truncate">{log.output_summary}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
