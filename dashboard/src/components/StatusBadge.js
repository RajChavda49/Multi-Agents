const STATUS_STYLES = {
  pending: "bg-slate-700 text-slate-200",
  phase_1_running: "bg-blue-600/30 text-blue-300 border border-blue-500/40",
  phase_2_running: "bg-violet-600/30 text-violet-300 border border-violet-500/40",
  running: "bg-blue-600/30 text-blue-300 border border-blue-500/40",
  developing: "bg-violet-600/30 text-violet-300 border border-violet-500/40",
  awaiting_gate_1: "bg-amber-600/30 text-amber-300 border border-amber-500/40",
  awaiting_gate_2: "bg-amber-600/30 text-amber-300 border border-amber-500/40",
  gate_1_approved: "bg-violet-600/30 text-violet-300 border border-violet-500/40",
  gate_1_rejected: "bg-red-600/30 text-red-300 border border-red-500/40",
  gate_2_approved: "bg-emerald-600/30 text-emerald-300 border border-emerald-500/40",
  gate_2_rejected: "bg-red-600/30 text-red-300 border border-red-500/40",
  phase_2_complete: "bg-emerald-600/30 text-emerald-300 border border-emerald-500/40",
  failed: "bg-red-700/40 text-red-200",
};

const STATUS_LABELS = {
  pending: "Pending",
  phase_1_running: "Phase 1 running",
  phase_2_running: "Phase 2 running",
  running: "Phase 1 running",
  developing: "Phase 2 running",
  awaiting_gate_1: "Awaiting Gate 1",
  awaiting_gate_2: "Awaiting Gate 2",
  gate_1_approved: "Phase 2 running",
  gate_1_rejected: "Gate 1 rejected",
  gate_2_approved: "Gate 2 approved",
  gate_2_rejected: "Gate 2 rejected",
  phase_2_complete: "Phase 2 complete",
  failed: "Failed",
};

export default function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] || "bg-slate-700 text-slate-300";
  const label = STATUS_LABELS[status] || (status || "unknown").replace(/_/g, " ");

  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}>
      {label}
    </span>
  );
}
