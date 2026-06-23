const AGENTS = [
  { id: "A1", name: "Knowledge", phase: 1 },
  { id: "A2", name: "Dev Plan", phase: 2 },
  { id: "A3", name: "Test Cases", phase: 3 },
  { id: "GATE_1", name: "Gate 1", phase: 4 },
];

function agentState(pipeline, agentId) {
  const logs = pipeline.agent_logs || [];
  const log = logs.find((l) => l.agent === agentId);
  const current = pipeline.current_agent;

  if (log?.status === "completed" || log?.status === "approved") return "done";
  if (log?.status === "rejected") return "rejected";
  if (current === agentId) return "active";
  if (pipeline.status === "awaiting_gate_1" && agentId === "GATE_1") return "waiting";
  return "pending";
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
    <div className="flex items-center gap-2 flex-wrap">
      {AGENTS.map((agent, i) => {
        const state = agentState(pipeline, agent.id);
        return (
          <div key={agent.id} className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg bg-slate-800/80 px-3 py-1.5 border border-slate-700">
              <span className={`h-2 w-2 rounded-full ${DOT[state]}`} />
              <span className="text-xs font-mono text-slate-400">{agent.id}</span>
              <span className="text-xs text-slate-200">{agent.name}</span>
            </div>
            {i < AGENTS.length - 1 && (
              <span className="text-slate-600 text-xs">→</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
