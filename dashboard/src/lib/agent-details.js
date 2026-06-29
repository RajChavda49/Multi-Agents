export const AGENTS = [
  { id: "A1", name: "Knowledge" },
  { id: "CLARIFY", name: "Targets" },
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

const ORDER = AGENTS.map((a) => a.id);

function agentLog(pipeline, agentId) {
  return (pipeline.agent_logs || []).find((l) => l.agent === agentId);
}

function completedAgents(pipeline) {
  return new Set(
    (pipeline.agent_logs || [])
      .filter((l) => l.status === "completed" || l.status === "approved")
      .map((l) => l.agent),
  );
}

export function runningAgents(pipeline) {
  const done = completedAgents(pipeline);

  const filterActive = (ids) => ids.filter((id) => !done.has(id));

  if (pipeline.active_agents?.length) {
    return filterActive(pipeline.active_agents);
  }
  if (pipeline.current_agent === "A4-A6") {
    return filterActive(["A4", "A5", "A6"]);
  }
  if (pipeline.current_agent === "WRITE") return [];
  if (pipeline.current_agent && !done.has(pipeline.current_agent)) {
    return [pipeline.current_agent];
  }
  return [];
}

export function agentState(pipeline, agentId) {
  const log = agentLog(pipeline, agentId);
  const active = runningAgents(pipeline);
  const status = pipeline.status;

  if (log?.status === "completed" || log?.status === "approved") return "done";
  if (log?.status === "rejected" || log?.status === "failed") return "rejected";
  if (active.includes(agentId)) return "active";
  if (
    status === "phase_1_running" &&
    agentId === "A1" &&
    !log &&
    (active.includes("A1") || !pipeline.current_agent || pipeline.current_agent === "A1")
  ) {
    return "active";
  }
  if (
    status === "phase_2_running" &&
    ["A7", "A8", "A9"].includes(agentId) &&
    active.includes(agentId)
  ) {
    return "active";
  }
  if (status === "awaiting_gate_1" && agentId === "GATE_1") return "waiting";
  if (status === "awaiting_gate_2" && agentId === "GATE_2") return "waiting";
  if (status === "awaiting_target_clarification" && agentId === "CLARIFY") return "waiting";
  if (status === "awaiting_target_clarification" && agentId === "A1") return "done";
  if (agentId === "CLARIFY") {
    const clarifyLog = agentLog(pipeline, "CLARIFY");
    if (clarifyLog?.status === "completed") return "done";
    if (status !== "awaiting_target_clarification") return "skipped";
  }

  const agentIdx = ORDER.indexOf(agentId);
  const furthest = furthestAgentIndex(pipeline);
  if (furthest > agentIdx) return "done";

  return "pending";
}

function furthestAgentIndex(pipeline) {
  const logs = pipeline.agent_logs || [];
  let max = -1;
  for (const log of logs) {
    const idx = ORDER.indexOf(log.agent);
    if (idx > max && (log.status === "completed" || log.status === "approved")) {
      max = idx;
    }
  }
  if (pipeline.status === "phase_2_complete") return ORDER.indexOf("GATE_2");
  if (pipeline.status === "awaiting_gate_2") return ORDER.indexOf("GATE_2");
  const active = runningAgents(pipeline);
  if (active.length) {
    const indices = active.map((id) => ORDER.indexOf(id)).filter((i) => i >= 0);
    if (indices.length) return Math.max(...indices);
  }
  if (pipeline.current_agent) {
    const idx = ORDER.indexOf(pipeline.current_agent);
    if (idx >= 0) return idx;
    if (pipeline.current_agent === "A4-A6") return ORDER.indexOf("A6");
  }
  return max;
}

function hasJsonData(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function hasCodeBundle(bundle) {
  return Boolean(bundle?.files?.length || bundle?.edits?.length);
}

export function getAgentDetail(pipeline, agentId) {
  const log = agentLog(pipeline, agentId);
  const state = agentState(pipeline, agentId);
  const meta = AGENTS.find((a) => a.id === agentId);

  const base = {
    id: agentId,
    title: meta ? `${agentId} — ${meta.name}` : agentId,
    state,
    log,
  };

  switch (agentId) {
    case "A1":
      return {
        ...base,
        kind: "json",
        data: pipeline.knowledge_context,
        hasDetail: hasJsonData(pipeline.knowledge_context) || state === "active",
      };
    case "CLARIFY":
      return {
        ...base,
        kind: "clarify",
        data: {
          issues: pipeline.knowledge_context?.clarification_issues,
          edit_targets: pipeline.knowledge_context?.edit_targets,
          matched_files: pipeline.knowledge_context?.matched_files,
          repo_path: pipeline.knowledge_context?.repo_path,
        },
        hasDetail:
          pipeline.status === "awaiting_target_clarification" ||
          Boolean(log) ||
          (pipeline.knowledge_context?.clarification_issues?.length > 0),
      };
    case "A2":
      return {
        ...base,
        kind: "json",
        data: pipeline.technical_spec,
        hasDetail: hasJsonData(pipeline.technical_spec) || state === "active",
      };
    case "A3":
      return {
        ...base,
        kind: "json",
        data: pipeline.test_cases,
        subtitle: pipeline.test_suite_name,
        hasDetail: hasJsonData(pipeline.test_cases) || state === "active",
      };
    case "GATE_1":
      return {
        ...base,
        kind: "gate",
        data: {
          approved: pipeline.gate_1_approved,
          feedback: pipeline.gate_1_feedback,
          status: pipeline.status,
        },
        hasDetail:
          pipeline.status === "awaiting_gate_1" ||
          pipeline.gate_1_approved != null ||
          Boolean(log),
      };
    case "A4":
      return {
        ...base,
        kind: "code",
        data: pipeline.frontend_code,
        hasDetail: hasCodeBundle(pipeline.frontend_code) || state === "active",
      };
    case "A5":
      return {
        ...base,
        kind: "code",
        data: pipeline.backend_code,
        hasDetail: hasCodeBundle(pipeline.backend_code) || state === "active",
      };
    case "A6":
      return {
        ...base,
        kind: "code",
        data: pipeline.test_code,
        hasDetail: hasCodeBundle(pipeline.test_code) || state === "active",
      };
    case "A7":
      return {
        ...base,
        kind: "json",
        data: pipeline.code_review,
        hasDetail: hasJsonData(pipeline.code_review) || state === "active",
      };
    case "A8":
      return {
        ...base,
        kind: "json",
        data: pipeline.test_execution,
        hasDetail: hasJsonData(pipeline.test_execution) || state === "active",
      };
    case "A9":
      return {
        ...base,
        kind: "json",
        data: pipeline.execution_report,
        hasDetail: hasJsonData(pipeline.execution_report) || state === "active",
      };
    case "GATE_2":
      return {
        ...base,
        kind: "gate",
        data: {
          approved: pipeline.gate_2_approved,
          feedback: pipeline.gate_2_feedback,
          status: pipeline.status,
          merge_request: pipeline.git_publish?.merge_request,
        },
        hasDetail:
          pipeline.status === "awaiting_gate_2" ||
          pipeline.gate_2_approved != null ||
          Boolean(log),
      };
    default:
      return { ...base, kind: "json", data: null, hasDetail: false };
  }
}

export function formatRunningLabel(pipeline) {
  if (pipeline.phase_2_substatus === "writing_code") {
    return "Applying generated code to repository…";
  }

  const active = runningAgents(pipeline);
  if (active.length > 1) {
    return `${active.join(", ")} generating code (Ollama — may take several minutes on CPU)…`;
  }
  if (active.length === 1) {
    return `${active[0]} running via Ollama…`;
  }
  if (pipeline.current_agent === "A4-A6") {
    return "A4–A6 generating code (Ollama — may take several minutes on CPU)…";
  }
  if (pipeline.current_agent === "WRITE") {
    return "Applying generated code to repository…";
  }
  if (pipeline.status === "awaiting_target_clarification") {
    return "Waiting for edit-target confirmation…";
  }
  return pipeline.current_agent
    ? `${pipeline.current_agent} running via Ollama…`
    : "Agents running…";
}
