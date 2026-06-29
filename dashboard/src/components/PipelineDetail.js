import { useState, useEffect } from "react";
import StatusBadge from "./StatusBadge.js";
import AgentTimeline from "./AgentTimeline.js";
import { api } from "../api.js";
import { formatRunningLabel } from "../lib/agent-details.js";
import PipelineLogs from "./PipelineLogs.js";

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
        Not satisfied with the output? Retry the pipeline — optionally add a comment so
        agents know what to fix.{" "}
        {retryPhaseLabel(pipeline.status, pipeline.gate_1_approved)}
      </p>
      <textarea
        value={retryReason}
        onChange={(e) => setRetryReason(e.target.value)}
        placeholder="Optional: what went wrong? e.g. spec missed the checkout flow…"
        rows={3}
        className="w-full rounded-lg bg-slate-900 border border-slate-600 px-3 py-2 text-sm"
      />
      <button
        type="button"
        onClick={onRetry}
        disabled={loading}
        className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-4 py-2 text-sm font-medium"
      >
        {loading ? "Retrying…" : retryReason.trim() ? "Retry with feedback" : "Retry"}
      </button>
    </div>
  );
}

function ClarifyPanel({
  title,
  description,
  issues,
  suggestedFiles,
  clarificationMode,
  targetPaths,
  setTargetPaths,
  allowNewFiles,
  setAllowNewFiles,
  notes,
  setNotes,
  loading,
  onConfirm,
}) {
  const noFilesMatched = clarificationMode === "no_files_matched";
  const [fileDecision, setFileDecision] = useState(null);

  useEffect(() => {
    if (!noFilesMatched) return;
    if (allowNewFiles) setFileDecision("create");
    else if (targetPaths.trim()) setFileDecision("edit");
  }, [noFilesMatched, allowNewFiles, targetPaths]);

  function selectCreate() {
    setFileDecision("create");
    setAllowNewFiles(true);
  }

  function selectEdit() {
    setFileDecision("edit");
    setAllowNewFiles(false);
  }

  const canConfirm = noFilesMatched
    ? fileDecision === "create" || (fileDecision === "edit" && targetPaths.trim())
    : Boolean(targetPaths.trim()) || allowNewFiles;

  return (
    <div className="rounded-xl border border-orange-500/40 bg-orange-950/30 p-5 space-y-3">
      <p className="text-orange-200 font-medium">{title}</p>
      <p className="text-xs text-orange-200/70">{description}</p>
      {issues?.length > 0 && (
        <ul className="text-xs text-orange-100/80 list-disc pl-4 space-y-1">
          {issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
        </ul>
      )}
      {suggestedFiles?.length > 0 && (
        <p className="text-xs text-slate-400">
          Suggested: {suggestedFiles.join(", ")}
        </p>
      )}

      {noFilesMatched ? (
        <div className="space-y-2 rounded-lg border border-orange-500/20 bg-slate-950/40 p-3">
          <p className="text-xs text-slate-200 font-medium">How should agents proceed?</p>
          <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
            <input
              type="radio"
              name="file-decision"
              checked={fileDecision === "create"}
              onChange={selectCreate}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium text-emerald-300">Create new file(s)</span>
              <span className="block text-slate-500 mt-0.5">
                Agents may add new components/pages (optional path hints below)
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
            <input
              type="radio"
              name="file-decision"
              checked={fileDecision === "edit"}
              onChange={selectEdit}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium text-sky-300">Edit existing file(s)</span>
              <span className="block text-slate-500 mt-0.5">
                Specify repo-relative paths that already exist
              </span>
            </span>
          </label>
        </div>
      ) : (
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={allowNewFiles}
            onChange={(e) => setAllowNewFiles(e.target.checked)}
            className="rounded"
          />
          Allow creating new files (only if no existing file fits)
        </label>
      )}

      <label className="block text-xs text-slate-300">
        {noFilesMatched && fileDecision === "create"
          ? "Optional — where to create new files (repo-relative paths)"
          : "Files to edit (repo-relative paths, one per line)"}
        <textarea
          value={targetPaths}
          onChange={(e) => setTargetPaths(e.target.value)}
          rows={3}
          placeholder={
            noFilesMatched && fileDecision === "create"
              ? "components/Home/HeroSection.js"
              : "components/Common/NewHeader/NewHeader.js"
          }
          className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-600 px-3 py-2 text-sm font-mono"
        />
      </label>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Optional notes for the agents…"
        rows={2}
        className="w-full rounded-lg bg-slate-900 border border-slate-600 px-3 py-2 text-sm"
      />
      <button
        onClick={onConfirm}
        disabled={loading || !canConfirm}
        className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-2 text-sm font-medium"
      >
        {noFilesMatched && fileDecision === "create"
          ? "Create new files & continue"
          : "Confirm & continue"}
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
  const [targetPaths, setTargetPaths] = useState("");
  const [allowNewFiles, setAllowNewFiles] = useState(false);
  const [clarifyNotes, setClarifyNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (
      pipeline.status === "awaiting_target_clarification" ||
      pipeline.status === "awaiting_code_clarification"
    ) {
      const paths = [
        ...(pipeline.knowledge_context?.edit_targets || [])
          .filter((t) => t.exists !== false)
          .map((t) => t.path),
        ...(pipeline.knowledge_context?.matched_files || []).map((f) => f.path),
      ];
      const unique = [...new Set(paths.filter(Boolean))];
      if (unique.length) setTargetPaths(unique.join("\n"));
    }
  }, [pipeline.status, pipeline.id, pipeline.knowledge_context]);

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
  const awaitingTargetClarify = pipeline.status === "awaiting_target_clarification";
  const awaitingCodeClarify = pipeline.status === "awaiting_code_clarification";
  const showRetry = canRetryPipeline(pipeline.status);
  const busy = loading || retrying;
  const isRunning = ["phase_1_running", "phase_2_running"].includes(pipeline.status);
  const runningLabel = formatRunningLabel(pipeline);

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

      {pipeline.jira_task?.description_images?.length > 0 && (
        <Section title="Jira description images">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {pipeline.jira_task.description_images.map((img) => (
              <div
                key={img.url || img.filename}
                className="rounded-lg border border-slate-700 overflow-hidden bg-slate-950/40"
              >
                <img
                  src={img.url}
                  alt={img.alt_text || img.filename}
                  className="w-full max-h-72 object-contain bg-slate-950"
                />
                <div className="p-3 text-xs space-y-1">
                  <p className="font-mono text-slate-300">{img.filename}</p>
                  {img.description && (
                    <p className="text-slate-400 leading-relaxed">{img.description}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

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
                <p className="text-slate-300 mt-0.5">{entry.reason || "(no comment)"}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(pipeline.git_branch || pipeline.git_publish?.merge_request) && (
        <Section title={`Git / ${pipeline.repo_source === "github" ? "GitHub" : pipeline.repo_source === "gitlab" ? "GitLab" : "Remote"}`}>
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
                Open {pipeline.repo_source === "github" ? "pull request" : "merge request"}
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

      {awaitingTargetClarify && (
        <ClarifyPanel
          title="❓ No matching files found"
          description={
            pipeline.knowledge_context?.requires_create_decision
              ? "Agents could not find existing files for this task. Choose whether to create new files or point to specific existing paths, then planning will continue."
              : "The agents could not confidently match existing repo files for this Jira task. Confirm paths or allow new file creation before planning continues."
          }
          issues={pipeline.knowledge_context?.clarification_issues}
          clarificationMode={pipeline.knowledge_context?.clarification_mode}
          suggestedFiles={(pipeline.knowledge_context?.edit_targets || []).map((t) => t.path)}
          targetPaths={targetPaths}
          setTargetPaths={setTargetPaths}
          allowNewFiles={allowNewFiles}
          setAllowNewFiles={setAllowNewFiles}
          notes={clarifyNotes}
          setNotes={setClarifyNotes}
          loading={busy}
          onConfirm={() =>
            runGate(() =>
              api.confirmTargets(pipeline.id, {
                confirmed_targets: targetPaths.trim() || undefined,
                allow_new_files: allowNewFiles,
                notes: clarifyNotes || undefined,
              }),
            )
          }
        />
      )}

      {awaitingCodeClarify && (
        <ClarifyPanel
          title="❓ Confirm code write"
          description="Generated code tried to create or modify files outside the confirmed targets. Confirm allowed paths or enable new file creation."
          issues={(pipeline.code_write_blocked || []).map(
            (b) => `${b.path}: ${b.reason}`,
          )}
          suggestedFiles={(pipeline.knowledge_context?.edit_targets || []).map((t) => t.path)}
          targetPaths={targetPaths}
          setTargetPaths={setTargetPaths}
          allowNewFiles={allowNewFiles}
          setAllowNewFiles={setAllowNewFiles}
          notes={clarifyNotes}
          setNotes={setClarifyNotes}
          loading={busy}
          onConfirm={() =>
            runGate(() =>
              api.confirmCodeWrite(pipeline.id, {
                confirmed_targets: targetPaths,
                allow_new_files: allowNewFiles,
                notes: clarifyNotes || undefined,
              }),
            )
          }
        />
      )}

      {awaitingGate1 && (
        <GatePanel
          title="🛑 Gate 1 — Review Spec & Test Plan"
          description={`Click A1–A3 in the pipeline above to review outputs. Approve to start Phase 2. Edit targets: ${
            (pipeline.knowledge_context?.edit_targets || [])
              .filter((t) => t.exists !== false)
              .map((t) => t.path)
              .join(", ") || "(none confirmed yet)"
          }`}
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

      {awaitingGate2 && (
        <GatePanel
          title="🛑 Gate 2 — Review Code, Tests & Report"
          description="Click A4–A9 in the pipeline above to review code, tests, and reports. Approve to publish and open a PR/MR."
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

      <PipelineLogs pipeline={pipeline} />
    </div>
  );
}
