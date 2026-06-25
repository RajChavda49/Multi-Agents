import { getPipeline, savePipeline } from "../storage/pipelines.js";

const PARALLEL_DEV_AGENTS = ["A4", "A5", "A6"];

export function formatRunningAgents(pipeline) {
  const active = pipeline?.active_agents || [];
  if (active.length > 1) return active.join(", ");
  if (active.length === 1) return active[0];
  if (pipeline?.current_agent === "A4-A6") return "A4–A6";
  return pipeline?.current_agent || null;
}

function resolveCurrentAgent(activeAgents) {
  if (!activeAgents.length) return null;
  if (activeAgents.length === 1) return activeAgents[0];
  return "A4-A6";
}

export function reportAgentActivity(pipelineId, patch) {
  const existing = getPipeline(pipelineId);
  if (!existing) return;

  savePipeline({
    ...existing,
    ...patch,
    updated_at: new Date().toISOString(),
  });
}

/** Mark a parallel dev agent (A4/A5/A6) as running without clobbering siblings. */
export function reportAgentStarted(pipelineId, agentId, patch = {}) {
  const existing = getPipeline(pipelineId);
  if (!existing) return;

  if (PARALLEL_DEV_AGENTS.includes(agentId)) {
    const active_agents = [...new Set([...(existing.active_agents || []), agentId])].sort(
      (a, b) => PARALLEL_DEV_AGENTS.indexOf(a) - PARALLEL_DEV_AGENTS.indexOf(b),
    );
    savePipeline({
      ...existing,
      ...patch,
      active_agents,
      current_agent: resolveCurrentAgent(active_agents),
      updated_at: new Date().toISOString(),
    });
    return;
  }

  savePipeline({
    ...existing,
    ...patch,
    active_agents: [agentId],
    current_agent: agentId,
    updated_at: new Date().toISOString(),
  });
}

/** Clear a parallel dev agent from the active set when it finishes. */
export function reportAgentFinished(pipelineId, agentId) {
  const existing = getPipeline(pipelineId);
  if (!existing) return;

  if (!PARALLEL_DEV_AGENTS.includes(agentId)) return;

  const active_agents = (existing.active_agents || []).filter((id) => id !== agentId);
  savePipeline({
    ...existing,
    active_agents,
    current_agent: resolveCurrentAgent(active_agents) ?? existing.current_agent,
    updated_at: new Date().toISOString(),
  });
}
