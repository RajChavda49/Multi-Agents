import { formatRunningLabel } from "./agent-details.js";

const LEVEL_CLASS = {
  info: "text-slate-400",
  success: "text-emerald-400",
  warn: "text-amber-400",
  error: "text-red-400",
  active: "text-cyan-400",
};

export function logLevelClass(level) {
  return LEVEL_CLASS[level] || LEVEL_CLASS.info;
}

function formatTime(iso) {
  if (!iso) return "--:--:--";
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "--:--:--";
  }
}

function entriesFromAgentLogs(pipeline) {
  const entries = [];
  for (const log of pipeline.agent_logs || []) {
    if (log.started_at) {
      entries.push({
        at: log.started_at,
        level: "info",
        agent: log.agent,
        message: `${log.agent} started`,
      });
    }
    if (log.completed_at) {
      entries.push({
        at: log.completed_at,
        level:
          log.status === "failed"
            ? "error"
            : log.status === "rejected"
              ? "warn"
              : "success",
        agent: log.agent,
        message: `${log.agent} ${log.status}${log.output_summary ? `: ${log.output_summary}` : ""}`,
      });
    }
  }
  return entries;
}

function entriesFromPipelineMeta(pipeline) {
  const entries = [];

  if (!pipeline.activity_log?.length && pipeline.created_at) {
    entries.push({
      at: pipeline.created_at,
      level: "info",
      message: `Pipeline created · ${pipeline.jira_task?.key || pipeline.id}`,
    });
  }

  if (pipeline.failure?.message) {
    entries.push({
      at: pipeline.failure.at || pipeline.updated_at,
      level: "error",
      agent: pipeline.failure.agent,
      message: pipeline.failure.message,
    });
  } else if (pipeline.error) {
    entries.push({
      at: pipeline.updated_at,
      level: "error",
      message: pipeline.error,
    });
  }

  for (const entry of pipeline.retry_history || []) {
    entries.push({
      at: entry.at,
      level: "warn",
      message: `Retry (${entry.phase}): ${entry.reason || "(no comment)"}`,
    });
  }

  if (pipeline.gate_1_approved === true) {
    entries.push({
      at: pipeline.updated_at,
      level: "success",
      message: `Gate 1 approved${pipeline.gate_1_feedback ? `: ${pipeline.gate_1_feedback}` : ""}`,
    });
  }
  if (pipeline.gate_1_approved === false) {
    entries.push({
      at: pipeline.updated_at,
      level: "warn",
      message: `Gate 1 rejected${pipeline.gate_1_feedback ? `: ${pipeline.gate_1_feedback}` : ""}`,
    });
  }
  if (pipeline.gate_2_approved === true) {
    entries.push({
      at: pipeline.updated_at,
      level: "success",
      message: `Gate 2 approved${pipeline.gate_2_feedback ? `: ${pipeline.gate_2_feedback}` : ""}`,
    });
  }

  return entries;
}

export function pipelineLiveLogLine(pipeline) {
  const running = ["phase_1_running", "phase_2_running"].includes(pipeline.status);
  if (!running) return null;
  return {
    at: pipeline.updated_at,
    level: "active",
    agent: pipeline.current_agent,
    message: formatRunningLabel(pipeline),
  };
}

function dedupeEntries(entries) {
  const seen = new Set();
  return entries.filter((e) => {
    const key = `${e.at}|${e.agent || ""}|${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildPipelineLogEntries(pipeline) {
  const fromActivity = (pipeline.activity_log || []).map((e) => ({
    at: e.at,
    level: e.level || "info",
    agent: e.agent,
    message: e.message,
  }));

  const merged = dedupeEntries([
    ...fromActivity,
    ...entriesFromAgentLogs(pipeline),
    ...entriesFromPipelineMeta(pipeline),
  ]);

  return merged.sort((a, b) => new Date(b.at) - new Date(a.at));
}

export function formatLogLine(entry) {
  const time = formatTime(entry.at);
  const agent = entry.agent ? ` [${entry.agent}]` : "";
  return `[${time}]${agent} ${entry.message}`;
}
