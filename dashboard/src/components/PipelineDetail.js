import { useState } from "react";
import StatusBadge from "./StatusBadge.js";
import AgentTimeline from "./AgentTimeline.js";
import { api } from "../api.js";

function Section({ title, children }) {
  return (
    <section className="rounded-xl border border-slate-700 bg-slate-900/40 overflow-hidden">
      <div className="px-4 py-2 border-b border-slate-700 bg-slate-800/50">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          {title}
        </h3>
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
        <div
          key={file.path}
          className="rounded-lg border border-slate-700 overflow-hidden"
        >
          <div className="px-3 py-1.5 bg-slate-800 text-xs font-mono text-blue-300">
            {file.path}
          </div>
          <pre className="p-3 text-xs text-slate-300 overflow-x-auto max-h-48">
            {file.content}
          </pre>
        </div>
      ))}
    </div>
  );
}

const RUNNING_STATUSES = ["pending", "phase_1_running", "phase_2_running"];

function canRetryPipeline(status) {
  return status && !RUNNING_STATUSES.includes(status);
}

function retryPhaseLabel(status, gate1Approved) {
  if (
    ["awaiting_gate_2", "gate_2_rejected", "phase_2_complete"].includes(status) &&
    gate1Approved
  ) {
    return "Phase 2 — agents will regenerate code & tests (A4–A6)";
  }
  return "Phase 1 — agents will regenerate spec & test plan (A1–A3)";
}

function FailurePanel({ pipeline }) {
  const failure = pipeline.failure;
  const message = pipeline.error || failure?.message;
  if (!message && pipeline.status !== "failed") return null;

  const agent =
    failure?.agent ||
    (pipeline.phase === "planning" && !pipeline.knowledge_context ? "A1" : null);
  const model = failure?.model;
  const hint =
    failure?.hint ||
    (/timeout|aborted/i.test(message || "")
      ? "Ollama took too long. A1 sends a large repo scan — we now trim it; you can also set OLLAMA_TIMEOUT_MS in backend/.env."
      : null);

  return (
    <div className="rounded-xl border border-red-500/50 bg-red-950/30 p-5 space-y-2">
      <p className="text-red-200 font-medium">Pipeline failed</p>
      {agent && (
        <p className="text-xs text-red-200/80">
          Failed at agent <span className="font-mono text-red-100">{agent}</span>
          {model && (
            <>
              {" "}
              · model <span className="font-mono text-red-100">{model}</span>
            </>
          )}
          {failure?.at && (
            <span className="text-red-300/60"> · {new Date(failure.at).toLocaleString()}</span>
          )}
        </p>
      )}
      <p className="text-sm text-red-100 font-mono whitespace-pre-wrap">{message}</p>
      {hint && (
        <p className="text-xs text-amber-200/90 border-t border-red-900/50 pt-2 mt-2">{hint}</p>
      )}
    </div>
  );
}

function RetryPanel({ pipeline, retryReason, setRetryReason, loading, onRetry }) {
  return (
    <div className="rounded-xl border border-violet-500/40 bg-violet-950/20 p-5 space-y-3">
      <p className="text-violet-200 font-medium">↻ Retry pipeline</p>
      <p className="text-xs text-violet-200/70">
        Not satisfied with the output? Explain what went wrong and agents will run
        again with your feedback.{" "}
        {retryPhaseLabel(pipeline.status, pipeline.gate_1_approved)}
      </p>
      <textarea
        value={retryReason}
        onChange={(e) => setRetryReason(e.target.value)}
        placeholder="What is wrong or missing? e.g. spec missed the checkout flow, tests don't cover edge cases…"
        rows={3}
        className="w-full rounded-lg bg-slate-900 border border-slate-600 px-3 py-2 text-sm"
      />
      <button
        type="button"
        onClick={onRetry}
        disabled={loading || !retryReason.trim()}
        className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-4 py-2 text-sm font-medium"
      >
        {loading ? "Retrying…" : "Retry with feedback"}
      </button>
    </div>
  );
}

function GatePanel({
  title,
  description,
  feedback,
  setFeedback,
  loading,
  onApprove,
  onReject,
}) {
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

export default function PipelineDetail({
  pipeline,
  onUpdate,
  onBack,
  onDelete,
}) {
  const [feedback, setFeedback] = useState("");
  const [retryReason, setRetryReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
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

  async function handleRetry() {
    const reason = retryReason.trim();
    if (!reason) return;

    setRetrying(true);
    setError(null);
    try {
      const { pipeline: updated } = await api.retryPipeline(pipeline.id, reason);
      onUpdate(updated);
      setRetryReason("");
    } catch (err) {
      setError(err.message);
    } finally {
      setRetrying(false);
    }
  }

  const awaitingGate1 = pipeline.status === "awaiting_gate_1";
  const awaitingGate2 = pipeline.status === "awaiting_gate_2";
  const showRetry = canRetryPipeline(pipeline.status);
  const busy = loading || retrying;
  const isRunning = ["phase_1_running", "phase_2_running"].includes(pipeline.status);

  const runningLabel =
    pipeline.current_agent === "A4-A6"
      ? "A4–A6 generating code (Ollama — may take several minutes on CPU)…"
      : pipeline.current_agent
        ? `${pipeline.current_agent} running via Ollama…`
        : "Agents running…";
  const showGeneratedCode = Boolean(pipeline.frontend_code);
  const showPostGate2 =
    pipeline.status === "awaiting_gate_2" ||
    pipeline.status === "phase_2_complete" ||
    pipeline.code_review ||
    pipeline.test_execution ||
    pipeline.execution_report;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <button
            onClick={onBack}
            className="text-xs text-slate-400 hover:text-slate-200 mb-2"
          >
            ← Back to pipelines
          </button>
          <h2 className="text-xl font-semibold">
            {pipeline.jira_task?.key} — {pipeline.jira_task?.summary}
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            {pipeline.jira_task?.description}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={pipeline.status} />
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting || busy}
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

      {isRunning && (
        <div className="rounded-xl border border-blue-500/40 bg-blue-950/30 px-4 py-3 flex items-center gap-3">
          <span className="h-2 w-2 rounded-full bg-blue-400 animate-pulse shrink-0" />
          <p className="text-sm text-blue-200">{runningLabel}</p>
        </div>
      )}

      <FailurePanel pipeline={pipeline} />

      {showRetry && (
        <RetryPanel
          pipeline={pipeline}
          retryReason={retryReason}
          setRetryReason={setRetryReason}
          loading={retrying}
          onRetry={handleRetry}
        />
      )}

      {pipeline.retry_history?.length > 0 && (
        <Section title="Retry history">
          <ul className="space-y-2 text-xs text-slate-400">
            {pipeline.retry_history.map((entry, i) => (
              <li key={i} className="border-l-2 border-violet-800 pl-3">
                <span className="text-slate-500">
                  {new Date(entry.at).toLocaleString()}
                </span>
                <span className="text-violet-300 ml-2">({entry.phase})</span>
                <p className="text-slate-300 mt-0.5">{entry.reason}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(pipeline.git_branch || pipeline.git_publish?.merge_request) && (
        <Section title="Git / GitLab">
          {pipeline.git_branch && (
            <p className="text-sm text-slate-300">
              Branch:{" "}
              <code className="text-sky-300">{pipeline.git_branch}</code>
              {pipeline.repo_source && (
                <span className="text-slate-500">
                  {" "}
                  · source: {pipeline.repo_source}
                </span>
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
            <p className="text-sm text-red-400 mt-2">
              Publish failed: {pipeline.git_publish.error}
            </p>
          )}
        </Section>
      )}

      {awaitingGate1 && (
        <GatePanel
          title="🛑 Gate 1 — Review Spec & Test Plan"
          description="Approve to start Phase 2: A4/A5/A6 code generation, then A7 code review (ESLint/syntax), A8 test execution, and A9 report — then Gate 2 for your sign-off."
          feedback={feedback}
          setFeedback={setFeedback}
          loading={busy}
          onApprove={() =>
            runGate(() => api.approveGate1(pipeline.id, feedback || undefined))
          }
          onReject={() =>
            runGate(() =>
              api.rejectGate1(
                pipeline.id,
                feedback || "Rejected from dashboard",
              ),
            )
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

      <Section
        title={`A3 — Test Cases${pipeline.test_suite_name ? `: ${pipeline.test_suite_name}` : ""}`}
      >
        <JsonBlock data={pipeline.test_cases} />
      </Section>

      {showGeneratedCode && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Section title="A4 — Frontend Code">
              <CodeFilesBlock
                codeBundle={pipeline.frontend_code}
                label="frontend"
              />
            </Section>
            <Section title="A5 — Backend Code">
              <CodeFilesBlock
                codeBundle={pipeline.backend_code}
                label="backend"
              />
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
                    {f.path}{" "}
                    <span className="text-slate-600">({f.size} bytes)</span>
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

      {awaitingGate2 && (
        <GatePanel
          title="🛑 Gate 2 — Review Code, Tests & Report"
          description="A7–A9 have finished. Review the code review (ESLint/syntax), test execution results, and execution report above. Approve to publish and proceed toward staging. Reject to stop the pipeline."
          feedback={feedback}
          setFeedback={setFeedback}
          loading={busy}
          onApprove={() =>
            runGate(() => api.approveGate2(pipeline.id, feedback || undefined))
          }
          onReject={() =>
            runGate(() =>
              api.rejectGate2(
                pipeline.id,
                feedback || "Rejected from dashboard",
              ),
            )
          }
        />
      )}

      {pipeline.agent_logs?.length > 0 && (
        <Section title="Agent Logs">
          <ul className="space-y-2">
            {pipeline.agent_logs.map((log, i) => (
              <li
                key={i}
                className="flex gap-3 text-xs font-mono text-slate-400"
              >
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
