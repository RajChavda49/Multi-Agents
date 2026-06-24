const AGENTS = [
  { id: "A1", name: "Knowledge" },
  { id: "A2", name: "Dev Plan" },
  { id: "A3", name: "Test Cases" },
  { id: "GATE_1", name: "Gate 1" },
  { id: "A4", name: "Frontend" },
  { id: "A5", name: "Backend" },
  { id: "A6", name: "Tests" },
  { id: "A7", name: "Review" },
  { id: "A8", name: "Test Exec" },
  { id: "A9", name: "Report" },
  { id: "GATE_2", name: "Gate 2" },
];

function agentState(pipeline, agentId) {
  const logs = pipeline.agent_logs || [];
  const log = logs.find((l) => l.agent === agentId);
  const current = pipeline.current_agent;
  const status = pipeline.status;

  if (log?.status === "completed" || log?.status === "approved") return "done";
  if (log?.status === "rejected" || log?.status === "failed") return "rejected";
  if (current === agentId || (agentId === "A4" && current === "A4-A6")) return "active";
  if (["A4", "A5", "A6"].includes(agentId) && current === "A4-A6") return "active";
  if (
    status === "phase_1_running" &&
    agentId === "A1" &&
    !log &&
    (!current || current === "A1")
  ) {
    return "active";
  }
  if (status === "phase_2_running" && ["A7", "A8", "A9"].includes(agentId) && current === agentId) {
    return "active";
  }
  if (status === "awaiting_gate_1" && agentId === "GATE_1") return "waiting";
  if (status === "awaiting_gate_2" && agentId === "GATE_2") return "waiting";

  const order = AGENTS.map((a) => a.id);
  const agentIdx = order.indexOf(agentId);
  const furthest = furthestAgentIndex(pipeline);
  if (furthest > agentIdx) return "done";

  return "pending";
}

function furthestAgentIndex(pipeline) {
  const order = AGENTS.map((a) => a.id);
  const logs = pipeline.agent_logs || [];
  let max = -1;
  for (const log of logs) {
    const idx = order.indexOf(log.agent);
    if (idx > max && (log.status === "completed" || log.status === "approved")) max = idx;
  }
  if (pipeline.status === "phase_2_complete") return order.indexOf("GATE_2");
  if (pipeline.status === "awaiting_gate_2") return order.indexOf("GATE_2");
  if (pipeline.current_agent) {
    const idx = order.indexOf(pipeline.current_agent);
    if (idx >= 0) return idx;
    if (pipeline.current_agent === "A4-A6") return order.indexOf("A6");
  }
  return max;
}

const DOT = {
  done: "bg-emerald-400",
  active: "bg-blue-400 animate-pulse",
  waiting: "bg-amber-400 animate-pulse",
  rejected: "bg-red-400",
  pending: "bg-slate-600",
};

export default function AgentTimeline({ pipeline }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {AGENTS.map((agent, i) => {
        const state = agentState(pipeline, agent.id);
        return (
          <div key={agent.id} className="flex items-center gap-1.5">
            <div className="flex items-center gap-1 rounded-lg bg-slate-800/80 px-2 py-1 border border-slate-700">
              <span className={`h-1.5 w-1.5 rounded-full ${DOT[state]}`} />
              <span className="text-[10px] font-mono text-slate-400">{agent.id}</span>
              <span className="text-[10px] text-slate-200 hidden sm:inline">{agent.name}</span>
            </div>
            {i < AGENTS.length - 1 && (
              <span className="text-slate-600 text-[10px]">→</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
