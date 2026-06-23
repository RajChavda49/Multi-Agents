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
    <pre className="text-xs text-slate-300 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

export default function PipelineDetail({ pipeline, onUpdate, onBack }) {
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleApprove() {
    setLoading(true);
    setError(null);
    try {
      const { pipeline: updated } = await api.approveGate1(pipeline.id, feedback || undefined);
      onUpdate(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleReject() {
    setLoading(true);
    setError(null);
    try {
      const { pipeline: updated } = await api.rejectGate1(
        pipeline.id,
        feedback || "Rejected from dashboard",
      );
      onUpdate(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const awaitingGate = pipeline.status === "awaiting_gate_1";

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
          <p className="text-sm text-slate-400 mt-1">{pipeline.jira_task?.description}</p>
        </div>
        <StatusBadge status={pipeline.status} />
      </div>

      <AgentTimeline pipeline={pipeline} />

      {awaitingGate && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-950/30 p-5 space-y-3">
          <p className="text-amber-200 font-medium">🛑 Gate 1 — Review Spec & Test Plan</p>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Optional feedback for approval or rejection..."
            rows={2}
            className="w-full rounded-lg bg-slate-900 border border-slate-600 px-3 py-2 text-sm"
          />
          <div className="flex gap-3">
            <button
              onClick={handleApprove}
              disabled={loading}
              className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-2 text-sm font-medium"
            >
              Approve Gate 1
            </button>
            <button
              onClick={handleReject}
              disabled={loading}
              className="rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-50 px-4 py-2 text-sm font-medium"
            >
              Reject
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

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
