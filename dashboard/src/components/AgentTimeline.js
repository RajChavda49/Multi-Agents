import { useState } from "react";
import {
  AGENTS,
  agentState,
  getAgentDetail,
} from "../lib/agent-details.js";
import AgentDetailModal from "./AgentDetailModal.js";

const NODE_W = 76;
const CONN_W = 24;
const PHASE_GAP = 12;
const ORB_SLOT = 52;

const PHASES = [
  { id: "planning", label: "Planning", color: "violet", agents: ["A1", "CLARIFY", "A2", "A3"] },
  { id: "gate1", label: "Gate 1", color: "amber", agents: ["GATE_1"] },
  { id: "dev", label: "Development", color: "cyan", agents: ["A4", "A5", "A6"] },
  { id: "review", label: "Review", color: "indigo", agents: ["A7", "A8", "A9"] },
  { id: "publish", label: "Publish", color: "emerald", agents: ["GATE_2"] },
];

const PHASE_TINT = {
  violet: "bg-violet-500/[0.07] border-violet-500/20",
  amber: "bg-amber-500/[0.08] border-amber-500/25",
  cyan: "bg-cyan-500/[0.07] border-cyan-500/20",
  indigo: "bg-indigo-500/[0.07] border-indigo-500/20",
  emerald: "bg-emerald-500/[0.07] border-emerald-500/20",
};

const AGENT_ICONS = {
  A1: "◈",
  CLARIFY: "◎",
  A2: "◇",
  A3: "☑",
  GATE_1: "⛨",
  A4: "◫",
  A5: "⚙",
  A6: "⚗",
  A7: "◎",
  A8: "▶",
  A9: "▤",
  GATE_2: "✦",
};

function agentMeta(agentId) {
  return AGENTS.find((a) => a.id === agentId);
}

function isGate(id) {
  return id.startsWith("GATE");
}

function phaseTrackWidth(agentCount) {
  return agentCount * NODE_W + Math.max(0, agentCount - 1) * CONN_W;
}

function buildPhaseBands() {
  const bands = [];
  let left = 0;
  for (let p = 0; p < PHASES.length; p++) {
    const phase = PHASES[p];
    const width = phaseTrackWidth(phase.agents.length);
    bands.push({ ...phase, left, width });
    left += width + (p < PHASES.length - 1 ? PHASE_GAP : 0);
  }
  return { bands, totalWidth: left };
}

function progressStats(pipeline) {
  const states = AGENTS.map((a) => agentState(pipeline, a.id));
  const done = states.filter((s) => progressedState(s)).length;
  const active = states.some((s) => s === "active");
  const waiting = states.some((s) => s === "waiting");
  const pct = Math.round((done / AGENTS.length) * 100);
  const activeAgent = AGENTS.find((a) => agentState(pipeline, a.id) === "active");
  const waitingAgent = AGENTS.find((a) => agentState(pipeline, a.id) === "waiting");
  return { done, total: AGENTS.length, pct, active, waiting, activeAgent, waitingAgent };
}

function progressedState(state) {
  return state === "done" || state === "skipped" || state === "rejected";
}

function connectorFilled(pipeline, fromIdx) {
  const toIdx = fromIdx + 1;
  if (toIdx >= AGENTS.length) return false;
  const fromState = agentState(pipeline, AGENTS[fromIdx].id);
  const toState = agentState(pipeline, AGENTS[toIdx].id);
  return (
    progressedState(fromState) ||
    progressedState(toState) ||
    toState === "active" ||
    toState === "waiting"
  );
}

function NodeOrb({ state, agentId }) {
  const icon = AGENT_ICONS[agentId] || "•";
  const gate = isGate(agentId);
  const shape = gate ? "rounded-xl" : "rounded-full";

  if (state === "active") {
    return (
      <div className="relative flex items-center justify-center" style={{ width: ORB_SLOT, height: ORB_SLOT }}>
        <span className="absolute rounded-full agent-orbit-ring" style={{ width: ORB_SLOT, height: ORB_SLOT }} />
        <span
          className="absolute rounded-full bg-cyan-400/20 blur-lg agent-active-glow"
          style={{ width: ORB_SLOT + 16, height: ORB_SLOT + 16 }}
        />
        <div
          className={[
            "relative z-10 flex items-center justify-center text-white text-base",
            shape,
            "bg-gradient-to-br from-cyan-400 via-blue-500 to-violet-600",
            "shadow-lg shadow-cyan-500/40 agent-active-bounce",
          ].join(" ")}
          style={{ width: ORB_SLOT, height: ORB_SLOT }}
        >
          {icon}
        </div>
        <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-300 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-200 border border-slate-900" />
        </span>
      </div>
    );
  }

  if (state === "done") {
    return (
      <div
        className={[
          "flex items-center justify-center",
          shape,
          "bg-gradient-to-br from-emerald-400/20 to-emerald-600/30",
          "border-2 border-emerald-400/60 shadow-md shadow-emerald-500/20",
        ].join(" ")}
        style={{ width: ORB_SLOT - 4, height: ORB_SLOT - 4 }}
      >
        <svg className="w-4 h-4 text-emerald-300" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
            clipRule="evenodd"
          />
        </svg>
      </div>
    );
  }

  if (state === "waiting") {
    return (
      <div
        className={[
          "flex items-center justify-center",
          shape,
          "bg-gradient-to-br from-amber-400/25 to-orange-500/20",
          "border-2 border-amber-400/70 shadow-lg shadow-amber-500/25 agent-gate-pulse",
        ].join(" ")}
        style={{ width: ORB_SLOT - 2, height: ORB_SLOT - 2 }}
      >
        <span className="text-amber-200 text-sm">{icon}</span>
      </div>
    );
  }

  if (state === "skipped") {
    return (
      <div
        className={[
          "flex items-center justify-center",
          shape,
          "border border-slate-700/40 bg-slate-900/20 text-slate-600",
        ].join(" ")}
        style={{ width: ORB_SLOT - 12, height: ORB_SLOT - 12 }}
      >
        <span className="text-[10px] opacity-50">{icon}</span>
      </div>
    );
  }

  if (state === "rejected") {
    return (
      <div
        className={["flex items-center justify-center text-red-400", shape, "bg-red-950/60 border-2 border-red-500/50"].join(
          " ",
        )}
        style={{ width: ORB_SLOT - 4, height: ORB_SLOT - 4 }}
      >
        ✕
      </div>
    );
  }

  return (
    <div
      className={[
        "flex items-center justify-center",
        shape,
        "border border-dashed border-slate-600/70 bg-slate-800/40 text-slate-500",
      ].join(" ")}
      style={{ width: ORB_SLOT - 8, height: ORB_SLOT - 8 }}
    >
      <span className="text-xs opacity-80">{icon}</span>
    </div>
  );
}

function Connector({ filled }) {
  return (
    <div
      className="shrink-0 flex items-center justify-center"
      style={{ width: CONN_W, height: ORB_SLOT }}
    >
      <div className="relative h-[2px] w-full rounded-full bg-slate-700/60 overflow-hidden">
        <div
          className={[
            "absolute inset-y-0 left-0 rounded-full transition-all duration-700",
            filled ? "w-full bg-gradient-to-r from-emerald-500/90 to-cyan-400/70 agent-connector-flow" : "w-0",
          ].join(" ")}
        />
      </div>
    </div>
  );
}

export default function AgentTimeline({ pipeline }) {
  const [selectedAgent, setSelectedAgent] = useState(null);
  const stats = progressStats(pipeline);
  const { bands, totalWidth } = buildPhaseBands();

  return (
    <>
      <div className="relative rounded-2xl overflow-hidden border border-white/[0.08] bg-slate-950 shadow-2xl shadow-black/50">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(56,189,248,0.1)_0%,_transparent_55%)] pointer-events-none" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_right,_rgba(139,92,246,0.08)_0%,_transparent_50%)] pointer-events-none" />

        {/* Header */}
        <div className="relative px-5 pt-5 pb-4 border-b border-white/[0.06]">
          <div className="flex items-center justify-between gap-4 flex-wrap mb-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
                <h3 className="text-sm font-semibold text-white">Agent Pipeline</h3>
              </div>
              <p className="text-[11px] text-slate-500 mt-1 ml-3.5">
                Tap a completed step to inspect output
              </p>
            </div>
            <div className="flex items-center gap-2 text-[10px]">
              <span className="px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-300">
                {stats.done}/{stats.total}
              </span>
              {stats.active && stats.activeAgent && (
                <span className="px-2.5 py-1 rounded-full bg-cyan-500/15 border border-cyan-400/40 text-cyan-200 agent-live-badge">
                  {stats.activeAgent.id} running
                </span>
              )}
            </div>
          </div>
          <div className="h-1 rounded-full bg-slate-800/80 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-500 via-cyan-400 to-emerald-400 transition-all duration-700 agent-progress-shine"
              style={{ width: `${Math.max(stats.pct, stats.active ? 6 : 0)}%` }}
            />
          </div>
        </div>

        {/* Track */}
        <div className="relative px-5 py-5 agent-timeline-scroll overflow-x-auto">
          <div className="relative" style={{ minWidth: totalWidth }}>

            {/* Phase bands + labels */}
            <div className="relative mb-3" style={{ height: 28 }}>
              {bands.map((band) => (
                <div
                  key={band.id}
                  className={["absolute top-0 rounded-lg border", PHASE_TINT[band.color]].join(" ")}
                  style={{ left: band.left, width: band.width, height: 28 }}
                >
                  <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-400 text-center leading-[28px]">
                    {band.label}
                  </p>
                </div>
              ))}
            </div>

            {/* Baseline track behind orbs */}
            <div
              className="absolute left-0 right-0 bg-slate-800/30 rounded-full pointer-events-none"
              style={{ top: 28 + 16 + ORB_SLOT / 2, height: 2, transform: "translateY(-50%)" }}
            />

            {/* Orbs row — single horizontal axis */}
            <div className="flex items-center" style={{ marginTop: 16 }}>
              {PHASES.map((phase, phaseIdx) => (
                <div key={phase.id} className="flex items-center shrink-0">
                  {phaseIdx > 0 && <div className="shrink-0" style={{ width: PHASE_GAP }} />}

                  {phase.agents.map((agentId, agentIdx) => {
                    const state = agentState(pipeline, agentId);
                    const detail = getAgentDetail(pipeline, agentId);
                    const disabled = !detail.hasDetail;
                    const globalIdx = AGENTS.findIndex((a) => a.id === agentId);
                    const isLastInPhase = agentIdx === phase.agents.length - 1;

                    return (
                      <div key={agentId} className="flex items-center shrink-0">
                        <div
                          className="shrink-0 flex flex-col items-center"
                          style={{ width: NODE_W }}
                        >
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => !disabled && setSelectedAgent(agentId)}
                            className={[
                              "group w-full flex flex-col items-center rounded-xl transition-colors",
                              disabled ? "cursor-not-allowed" : "cursor-pointer hover:bg-white/[0.03]",
                              state === "active" ? "agent-active-card rounded-xl py-1" : "py-1",
                            ].join(" ")}
                          >
                            <div
                              className="flex items-center justify-center shrink-0"
                              style={{ width: ORB_SLOT, height: ORB_SLOT }}
                            >
                              <NodeOrb state={state} agentId={agentId} />
                            </div>

                            <div className="mt-2 text-center w-full px-0.5 min-h-[2.75rem]">
                              <p
                                className={[
                                  "text-[11px] font-bold font-mono leading-none",
                                  state === "active"
                                    ? "text-cyan-100"
                                    : state === "done"
                                      ? "text-emerald-300"
                                      : state === "waiting"
                                        ? "text-amber-200"
                                        : "text-slate-500",
                                ].join(" ")}
                              >
                                {agentId.replace("GATE_", "G")}
                              </p>
                              <p
                                className={[
                                  "text-[10px] mt-1 leading-tight truncate",
                                  state === "active"
                                    ? "text-cyan-400/80"
                                    : state === "done"
                                      ? "text-emerald-500/70"
                                      : "text-slate-600",
                                ].join(" ")}
                              >
                                {agentMeta(agentId)?.name}
                              </p>

                              {state === "active" && (
                                <span className="inline-block mt-1.5 text-[7px] font-bold uppercase tracking-wider text-cyan-950 bg-gradient-to-r from-cyan-300 to-sky-300 px-1.5 py-px rounded-full">
                                  Live
                                </span>
                              )}
                              {state === "waiting" && (
                                <span className="inline-block mt-1.5 text-[7px] font-bold uppercase tracking-wider text-amber-950 bg-amber-300/90 px-1.5 py-px rounded-full">
                                  Review
                                </span>
                              )}
                            </div>
                          </button>
                        </div>

                        {!isLastInPhase && (
                          <Connector filled={connectorFilled(pipeline, globalIdx)} />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {selectedAgent && (
        <AgentDetailModal
          pipeline={pipeline}
          agentId={selectedAgent}
          onClose={() => setSelectedAgent(null)}
        />
      )}
    </>
  );
}
