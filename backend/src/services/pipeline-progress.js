import { getPipeline, savePipeline } from "../storage/pipelines.js";

const PARALLEL_DEV_AGENTS = ["A4", "A5", "A6"];
const MAX_ACTIVITY_LOG = 300;

function appendActivityEntries(existingLog, entries) {
  const next = [...(existingLog || [])];
  for (const entry of entries) {
    if (!entry?.message) continue;
    const at = entry.at || new Date().toISOString();
    const dup = next.some(
      (e) => e.at === at && e.message === entry.message && e.agent === entry.agent,
    );
    if (!dup) {
      next.push({
        at,
        level: entry.level || "info",
        agent: entry.agent || null,
        message: entry.message,
      });
    }
  }
  return next.slice(-MAX_ACTIVITY_LOG);
}

function activityFromAgentLogs(incomingLogs = []) {
  return incomingLogs
    .filter((log) => log.completed_at && log.output_summary)
    .map((log) => ({
      at: log.completed_at,
      level:
        log.status === "failed" ? "error" : log.status === "rejected" ? "warn" : "success",
      agent: log.agent,
      message: `${log.agent} ${log.status}: ${log.output_summary}`,
    }));
}

function activityFromPatch(existing, patch) {
  const entries = [];
  const { activity_message, activity_level, agent, ...rest } = patch;

  if (activity_message) {
    entries.push({ level: activity_level || "info", agent, message: activity_message });
  }
  if (rest.status && rest.status !== existing.status) {
    entries.push({ level: "info", message: `Status → ${rest.status}` });
  }
  if (rest.current_agent && rest.current_agent !== existing.current_agent) {
    entries.push({
      level: "info",
      agent: rest.current_agent,
      message: `${rest.current_agent} running`,
    });
  }
  if (rest.phase_2_substatus && rest.phase_2_substatus !== existing.phase_2_substatus) {
    entries.push({ level: "info", message: rest.phase_2_substatus.replace(/_/g, " ") });
  }
  return { entries, rest };
}

export function logPipelineEvent(pipelineId, entry) {
  const existing = getPipeline(pipelineId);
  if (!existing) return;
  savePipeline({
    ...existing,
    activity_log: appendActivityEntries(existing.activity_log, [entry]),
    updated_at: new Date().toISOString(),
  });
}

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

  const { entries, rest } = activityFromPatch(existing, patch);
  const fromAgents = activityFromAgentLogs(rest.agent_logs);
  const activity_log = appendActivityEntries(existing.activity_log, [...entries, ...fromAgents]);

  savePipeline({
    ...existing,
    ...rest,
    activity_log,
    updated_at: new Date().toISOString(),
  });
}

/** Mark a parallel dev agent (A4/A5/A6) as running without clobbering siblings. */
export function reportAgentStarted(pipelineId, agentId, patch = {}) {
  const existing = getPipeline(pipelineId);
  if (!existing) return;

  const startPatch = {
    ...patch,
    activity_message: `${agentId} started`,
    agent: agentId,
  };

  if (PARALLEL_DEV_AGENTS.includes(agentId)) {
    const active_agents = [...new Set([...(existing.active_agents || []), agentId])].sort(
      (a, b) => PARALLEL_DEV_AGENTS.indexOf(a) - PARALLEL_DEV_AGENTS.indexOf(b),
    );
    reportAgentActivity(pipelineId, {
      ...startPatch,
      active_agents,
      current_agent: resolveCurrentAgent(active_agents),
    });
    return;
  }

  reportAgentActivity(pipelineId, {
    ...startPatch,
    active_agents: [agentId],
    current_agent: agentId,
  });
}

function mergeAgentLogs(existingLogs, incomingLogs) {
  let agent_logs = existingLogs || [];
  for (const log of incomingLogs || []) {
    const dup = agent_logs.some(
      (e) => e.agent === log.agent && e.completed_at === log.completed_at,
    );
    if (!dup) agent_logs = [...agent_logs, log];
  }
  return agent_logs;
}

function resolveParallelProgress(existing, agentId) {
  const active_agents = (existing.active_agents || []).filter((id) => id !== agentId);
  const stillRunning = active_agents.length > 0;

  return {
    active_agents,
    current_agent: stillRunning ? resolveCurrentAgent(active_agents) : "WRITE",
    phase_2_substatus: stillRunning ? existing.phase_2_substatus : "writing_code",
  };
}

/** Clear a parallel dev agent from the active set when it finishes. */
export function reportAgentFinished(pipelineId, agentId) {
  reportAgentCompleted(pipelineId, agentId);
}

/** Persist parallel agent output as soon as it finishes (before sibling agents / file write). */
export function reportAgentCompleted(pipelineId, agentId, patch = {}) {
  const existing = getPipeline(pipelineId);
  if (!existing) return;

  const { agent_logs: incomingLogs, ...rest } = patch;
  const agent_logs = mergeAgentLogs(existing.agent_logs, incomingLogs);
  const fromAgents = activityFromAgentLogs(incomingLogs);

  const progress = PARALLEL_DEV_AGENTS.includes(agentId)
    ? resolveParallelProgress(existing, agentId)
    : {
        active_agents: existing.active_agents,
        current_agent: existing.current_agent,
        phase_2_substatus: existing.phase_2_substatus,
      };

  const { entries, rest: progressRest } = activityFromPatch(existing, progress);
  const activity_log = appendActivityEntries(existing.activity_log, [
    ...entries,
    ...fromAgents,
  ]);

  savePipeline({
    ...existing,
    ...rest,
    ...progressRest,
    agent_logs,
    activity_log,
    updated_at: new Date().toISOString(),
  });
}

export function reportAgentFailed(pipelineId, agentId, err) {
  const existing = getPipeline(pipelineId);
  if (!existing) return;

  const progress = PARALLEL_DEV_AGENTS.includes(agentId)
    ? resolveParallelProgress(existing, agentId, {})
    : {
        active_agents: existing.active_agents,
        current_agent: existing.current_agent,
        phase_2_substatus: existing.phase_2_substatus,
      };

  savePipeline({
    ...existing,
    ...progress,
    agent_logs: mergeAgentLogs(existing.agent_logs, [
      {
        agent: agentId,
        name: agentId,
        status: "failed",
        completed_at: new Date().toISOString(),
        output_summary: err?.message || "Agent failed",
      },
    ]),
    activity_log: appendActivityEntries(existing.activity_log, [
      {
        level: "error",
        agent: agentId,
        message: `${agentId} failed: ${err?.message || "Agent failed"}`,
      },
    ]),
    updated_at: new Date().toISOString(),
  });
}
