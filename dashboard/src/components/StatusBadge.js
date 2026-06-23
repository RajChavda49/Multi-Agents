const STATUS_STYLES = {
  pending: "bg-slate-700 text-slate-200",
  running: "bg-blue-600/30 text-blue-300 border border-blue-500/40",
  awaiting_gate_1: "bg-amber-600/30 text-amber-300 border border-amber-500/40",
  gate_1_approved: "bg-emerald-600/30 text-emerald-300 border border-emerald-500/40",
  gate_1_rejected: "bg-red-600/30 text-red-300 border border-red-500/40",
  failed: "bg-red-700/40 text-red-200",
};

export default function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] || "bg-slate-700 text-slate-300";
  const label = (status || "unknown").replace(/_/g, " ");

  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${style}`}>
      {label}
    </span>
  );
}
