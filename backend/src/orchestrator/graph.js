import { Annotation, StateGraph, START, END, interrupt, MemorySaver } from "@langchain/langgraph";
import { runA1Knowledge } from "./agents/a1-knowledge.js";
import { runA2DevPlan } from "./agents/a2-dev-plan.js";
import { runA3TestCases } from "./agents/a3-test-cases.js";
import { runA4Frontend } from "./agents/a4-frontend.js";
import { runA5Backend } from "./agents/a5-backend.js";
import { runA6TestCoding } from "./agents/a6-test-coding.js";
import { config } from "../config.js";
import { runA7CodeReview } from "./agents/a7-code-review.js";
import { runA8TestExec } from "./agents/a8-test-exec.js";
import { runA9Report } from "./agents/a9-report.js";
import { writeCodeFiles, listWorkspaceFiles } from "./workspace.js";
import { ensureRepoReady } from "../integrations/repo-target.js";
import { applyUserTargetConfirmation } from "../integrations/edit-targets.js";
import { validateGeneratedFiles } from "../integrations/code-write-guard.js";
import { reportAgentActivity } from "../services/pipeline-progress.js";
import { assertPipelineActive } from "../services/pipeline-run-control.js";
import { getPipeline } from "../storage/pipelines.js";

function saveNodeProgress(pipelineId, patch) {
  const existing = getPipeline(pipelineId);
  if (!existing) return;
  let agent_logs = existing.agent_logs || [];
  if (patch.agent_logs?.length) {
    for (const log of patch.agent_logs) {
      const dup = agent_logs.some(
        (e) => e.agent === log.agent && e.completed_at === log.completed_at,
      );
      if (!dup) agent_logs = [...agent_logs, log];
    }
  }
  const { agent_logs: _drop, ...rest } = patch;
  reportAgentActivity(pipelineId, { ...rest, agent_logs });
}

async function a1Node(state) {
  assertPipelineActive(state.pipeline_id);
  const result = {
    ...(await runA1Knowledge(state)),
    status: "phase_1_running",
    phase: "planning",
    current_agent: "A1",
  };
  saveNodeProgress(state.pipeline_id, {
    current_agent: "A1",
    knowledge_context: result.knowledge_context,
    agent_logs: result.agent_logs,
  });
  return result;
}

async function clarifyTargetsNode(state) {
  const knowledge = state.knowledge_context;
  if (!knowledge?.needs_target_clarification) {
    return {};
  }

  reportAgentActivity(state.pipeline_id, {
    status: "awaiting_target_clarification",
    phase: "planning",
    current_agent: "CLARIFY",
  });

  const decision = interrupt({
    gate: "TARGET_CLARIFY",
    message:
      "Could not confidently locate existing files to edit. Confirm the correct repo paths before planning continues.",
    issues: knowledge.clarification_issues || [],
    suggested_files: (knowledge.edit_targets || []).map((t) => t.path),
    matched_files: (knowledge.matched_files || []).map((f) => f.path),
    repo_path: knowledge.repo_path,
  });

  const updatedKnowledge = applyUserTargetConfirmation(knowledge, decision, state.jira_task);

  return {
    knowledge_context: updatedKnowledge,
    agent_logs: [
      {
        agent: "CLARIFY",
        name: "Target Clarification",
        status: "completed",
        completed_at: new Date().toISOString(),
        output_summary: `Confirmed ${(updatedKnowledge.edit_targets || []).filter((t) => t.exists).length} file(s) to edit`,
      },
    ],
  };
}

async function a2Node(state) {
  assertPipelineActive(state.pipeline_id);
  const result = {
    ...(await runA2DevPlan(state)),
    status: "phase_1_running",
    current_agent: "A2",
  };
  saveNodeProgress(state.pipeline_id, {
    current_agent: "A2",
    technical_spec: result.technical_spec,
    agent_logs: result.agent_logs,
  });
  return result;
}

async function a3Node(state) {
  assertPipelineActive(state.pipeline_id);
  const result = {
    ...(await runA3TestCases(state)),
    status: "phase_1_running",
    current_agent: "A3",
  };
  saveNodeProgress(state.pipeline_id, {
    current_agent: "A3",
    test_cases: result.test_cases,
    test_suite_name: result.test_suite_name,
    agent_logs: result.agent_logs,
  });
  return result;
}

const PipelineAnnotation = Annotation.Root({
  pipeline_id: Annotation(),
  jira_task: Annotation(),
  phase: Annotation(),
  status: Annotation(),
  current_agent: Annotation(),
  knowledge_context: Annotation(),
  technical_spec: Annotation(),
  test_cases: Annotation(),
  test_suite_name: Annotation(),
  gate_1_approved: Annotation(),
  gate_1_feedback: Annotation(),
  repo_source: Annotation(),
  git_branch: Annotation(),
  frontend_code: Annotation(),
  backend_code: Annotation(),
  test_code: Annotation(),
  workspace_files: Annotation(),
  code_review: Annotation(),
  test_execution: Annotation(),
  execution_report: Annotation(),
  gate_2_approved: Annotation(),
  gate_2_feedback: Annotation(),
  retry_feedback: Annotation(),
  error: Annotation(),
  agent_logs: Annotation({
    reducer: (left, right) => {
      if (!right) return left || [];
      if (!left) return right;
      return [...left, ...right];
    },
    default: () => [],
  }),
});

async function gate1Node(state) {
  const decision = interrupt({
    gate: "GATE_1",
    message: "Review technical spec and test plan before development begins.",
    pipeline_id: state.pipeline_id,
    jira_key: state.jira_task?.key,
    technical_spec: state.technical_spec,
    test_cases: state.test_cases,
    test_suite_name: state.test_suite_name,
  });

  const approved = decision?.approved === true;

  return {
    gate_1_approved: approved,
    gate_1_feedback: decision?.feedback || null,
    status: approved ? "phase_2_running" : "gate_1_rejected",
    phase: approved ? "development" : state.phase,
    current_agent: "GATE_1",
    agent_logs: [
      {
        agent: "GATE_1",
        name: "Human Gate 1",
        status: approved ? "approved" : "rejected",
        completed_at: new Date().toISOString(),
        output_summary: approved
          ? "Spec & test plan approved — starting development"
          : `Rejected: ${decision?.feedback || "no feedback"}`,
      },
    ],
  };
}

function routeAfterGate1(state) {
  return state.gate_1_approved ? "dev_parallel" : END;
}

async function devParallelNode(state) {
  assertPipelineActive(state.pipeline_id);
  reportAgentActivity(state.pipeline_id, {
    status: "phase_2_running",
    phase: "development",
    current_agent: "A4-A6",
    active_agents: config.skipBackendAgent ? ["A4", "A6"] : ["A4", "A5", "A6"],
  });

  let repoReady = { source: "none", path: null, branch: null };
  try {
    repoReady = await ensureRepoReady({
      id: state.pipeline_id,
      pipeline_id: state.pipeline_id,
      jira_task: state.jira_task,
      git_branch: state.git_branch,
    });
  } catch (err) {
    repoReady = { source: "error", path: null, branch: null, error: err.message };
  }

  const a4Promise = runA4Frontend(state);
  const a6Promise = runA6TestCoding(state);

  let a4;
  let a5;
  let a6;

  if (config.skipBackendAgent) {
    const skippedAt = new Date().toISOString();
    a5 = {
      backend_code: { files: [], skipped: true, reason: "A5 disabled — backend coding skipped" },
      agent_logs: [
        {
          agent: "A5",
          name: "Backend Coding Agent",
          status: "completed",
          started_at: skippedAt,
          completed_at: skippedAt,
          output_summary: "Skipped (A5 disabled)",
        },
      ],
    };
    [a4, a6] = await Promise.all([a4Promise, a6Promise]);
  } else {
    [a4, a5, a6] = await Promise.all([a4Promise, runA5Backend(state), a6Promise]);
  }

  const allFiles = [
    ...(a4.frontend_code?.files || []),
    ...(a5.backend_code?.files || []),
    ...(a6.test_code?.files || []),
  ];

  let filesToWrite = allFiles;
  let knowledge = state.knowledge_context;
  let validation = validateGeneratedFiles(filesToWrite, knowledge);

  if (validation.needs_clarification) {
    saveNodeProgress(state.pipeline_id, {
      code_write_blocked: validation.blocked,
      frontend_code: a4.frontend_code,
      backend_code: a5.backend_code,
      test_code: a6.test_code,
    });

    reportAgentActivity(state.pipeline_id, {
      status: "awaiting_code_clarification",
      phase: "development",
      current_agent: "CLARIFY",
    });

    const decision = interrupt({
      gate: "CODE_WRITE_CLARIFY",
      message:
        "Generated code tried to create or modify files outside the confirmed edit targets.",
      blocked: validation.blocked,
      proposed_files: filesToWrite.map((f) => f.path),
      edit_targets: (knowledge.edit_targets || []).map((t) => t.path),
    });

    knowledge = applyUserTargetConfirmation(knowledge, decision, state.jira_task);
    validation = validateGeneratedFiles(filesToWrite, knowledge);

    if (!decision.allow_new_files) {
      filesToWrite = validation.valid;
    }

    if (!filesToWrite.length) {
      throw new Error(
        `No files approved for write. Blocked: ${validation.blocked.map((b) => b.path).join(", ")}`,
      );
    }
  }

  assertPipelineActive(state.pipeline_id);
  const priorSnapshots = getPipeline(state.pipeline_id)?.repo_snapshots || {};
  const writeResult = writeCodeFiles(state.pipeline_id, filesToWrite, priorSnapshots);
  const workspace_files = listWorkspaceFiles(state.pipeline_id, writeResult);

  saveNodeProgress(state.pipeline_id, {
    frontend_code: a4.frontend_code,
    backend_code: a5.backend_code,
    test_code: a6.test_code,
    workspace_files,
    code_write_result: writeResult,
    repo_snapshots: writeResult.repo_snapshots,
    knowledge_context: knowledge,
    agent_logs: [
      ...(a4.agent_logs || []),
      ...(a5.agent_logs || []),
      ...(a6.agent_logs || []),
    ],
  });

  return {
    phase: "development",
    status: "phase_2_running",
    current_agent: "A7",
    active_agents: [],
    repo_source: repoReady.source,
    git_branch: repoReady.branch,
    repo_ready: repoReady,
    frontend_code: a4.frontend_code,
    backend_code: a5.backend_code,
    test_code: a6.test_code,
    workspace_files,
    code_write_result: writeResult,
    agent_logs: [...(a4.agent_logs || []), ...(a5.agent_logs || []), ...(a6.agent_logs || [])],
  };
}

async function a7Node(state) {
  assertPipelineActive(state.pipeline_id);
  reportAgentActivity(state.pipeline_id, {
    status: "phase_2_running",
    phase: "development",
    current_agent: "A7",
    active_agents: [],
  });
  const result = {
    ...(await runA7CodeReview(state)),
    status: "phase_2_running",
    phase: "development",
    current_agent: "A7",
  };
  saveNodeProgress(state.pipeline_id, {
    current_agent: "A7",
    code_review: result.code_review,
    agent_logs: result.agent_logs,
  });
  return result;
}

async function a8Node(state) {
  assertPipelineActive(state.pipeline_id);
  reportAgentActivity(state.pipeline_id, {
    status: "phase_2_running",
    phase: "development",
    current_agent: "A8",
  });
  const result = {
    ...(await runA8TestExec(state)),
    status: "phase_2_running",
    phase: "development",
    current_agent: "A8",
  };
  saveNodeProgress(state.pipeline_id, {
    current_agent: "A8",
    test_execution: result.test_execution,
    agent_logs: result.agent_logs,
  });
  return result;
}

async function a9Node(state) {
  assertPipelineActive(state.pipeline_id);
  reportAgentActivity(state.pipeline_id, {
    status: "phase_2_running",
    phase: "development",
    current_agent: "A9",
  });
  const result = {
    ...(await runA9Report(state)),
    status: "phase_2_running",
    phase: "development",
    current_agent: "A9",
  };
  saveNodeProgress(state.pipeline_id, {
    current_agent: "A9",
    execution_report: result.execution_report,
    agent_logs: result.agent_logs,
  });
  return result;
}

async function gate2Node(state) {
  reportAgentActivity(state.pipeline_id, {
    status: "phase_2_running",
    phase: "development",
    current_agent: "GATE_2",
  });

  const decision = interrupt({
    gate: "GATE_2",
    message:
      "Review code review (ESLint/syntax), test execution results, and the execution report before approving deployment to staging.",
    pipeline_id: state.pipeline_id,
    jira_key: state.jira_task?.key,
    test_cases: state.test_cases,
    test_suite_name: state.test_suite_name,
    frontend_code: state.frontend_code,
    backend_code: state.backend_code,
    test_code: state.test_code,
    workspace_files: state.workspace_files,
    code_review: state.code_review,
    test_execution: state.test_execution,
    execution_report: state.execution_report,
  });

  const approved = decision?.approved === true;

  return {
    gate_2_approved: approved,
    gate_2_feedback: decision?.feedback || null,
    status: approved ? "phase_2_complete" : "gate_2_rejected",
    current_agent: "GATE_2",
    agent_logs: [
      {
        agent: "GATE_2",
        name: "Human Gate 2",
        status: approved ? "approved" : "rejected",
        completed_at: new Date().toISOString(),
        output_summary: approved
          ? "Approved — ready for staging / merge request"
          : `Rejected: ${decision?.feedback || "no feedback"}`,
      },
    ],
  };
}

function buildGraph() {
  const graph = new StateGraph(PipelineAnnotation)
    .addNode("a1_knowledge", a1Node)
    .addNode("clarify_targets", clarifyTargetsNode)
    .addNode("a2_dev_plan", a2Node)
    .addNode("a3_test_cases", a3Node)
    .addNode("gate_1", gate1Node)
    .addNode("dev_parallel", devParallelNode)
    .addNode("a7_code_review", a7Node)
    .addNode("a8_test_exec", a8Node)
    .addNode("a9_report", a9Node)
    .addNode("gate_2", gate2Node)
    .addEdge(START, "a1_knowledge")
    .addEdge("a1_knowledge", "clarify_targets")
    .addEdge("clarify_targets", "a2_dev_plan")
    .addEdge("a2_dev_plan", "a3_test_cases")
    .addEdge("a3_test_cases", "gate_1")
    .addConditionalEdges("gate_1", routeAfterGate1, ["dev_parallel", END])
    .addEdge("dev_parallel", "a7_code_review")
    .addEdge("a7_code_review", "a8_test_exec")
    .addEdge("a8_test_exec", "a9_report")
    .addEdge("a9_report", "gate_2")
    .addEdge("gate_2", END);

  const checkpointer = new MemorySaver();
  return graph.compile({ checkpointer });
}

let compiledGraph = null;

export function getGraph() {
  if (!compiledGraph) {
    compiledGraph = buildGraph();
  }
  return compiledGraph;
}

export function graphConfig(threadId) {
  return { configurable: { thread_id: threadId } };
}

export function graphThreadId(pipeline) {
  return pipeline?.graph_thread_id || pipeline?.id || pipeline?.pipeline_id;
}

async function snapshotFor(threadId) {
  const graph = getGraph();
  return graph.getState(graphConfig(threadId));
}

export async function isAwaitingTargetClarify(threadId) {
  const snapshot = await snapshotFor(threadId);
  const pending = snapshot?.next?.includes("clarify_targets");
  const hasInterrupt = snapshot?.tasks?.some(
    (task) => task.name === "clarify_targets" && task.interrupts?.length > 0,
  );
  return pending || hasInterrupt;
}

export async function isAwaitingCodeWriteClarify(threadId) {
  const snapshot = await snapshotFor(threadId);
  const pending = snapshot?.next?.includes("dev_parallel");
  const hasInterrupt = snapshot?.tasks?.some(
    (task) => task.name === "dev_parallel" && task.interrupts?.length > 0,
  );
  return pending || hasInterrupt;
}

export async function isAwaitingGate1(threadId) {
  const snapshot = await snapshotFor(threadId);
  const pendingGate = snapshot?.next?.includes("gate_1");
  const hasInterrupt = snapshot?.tasks?.some(
    (task) => task.name === "gate_1" && task.interrupts?.length > 0,
  );
  return pendingGate || hasInterrupt;
}

export async function isAwaitingGate2(pipelineId) {
  const snapshot = await snapshotFor(pipelineId);
  const pendingGate = snapshot?.next?.includes("gate_2");
  const hasInterrupt = snapshot?.tasks?.some(
    (task) => task.name === "gate_2" && task.interrupts?.length > 0,
  );
  return pendingGate || hasInterrupt;
}

export async function resolveStatus(pipelineId, result) {
  if (await isAwaitingTargetClarify(pipelineId)) return "awaiting_target_clarification";
  if (await isAwaitingCodeWriteClarify(pipelineId)) return "awaiting_code_clarification";
  if (await isAwaitingGate1(pipelineId)) return "awaiting_gate_1";
  if (await isAwaitingGate2(pipelineId)) return "awaiting_gate_2";
  if (result?.gate_2_approved === true || result?.status === "phase_2_complete") {
    return "phase_2_complete";
  }
  if (result?.gate_2_approved === false || result?.status === "gate_2_rejected") {
    return "gate_2_rejected";
  }
  if (result?.gate_1_approved === false) return "gate_1_rejected";
  if (result?.phase === "development" || result?.gate_1_approved === true) {
    return "phase_2_running";
  }
  if (result?.phase === "planning") return "phase_1_running";
  return result?.status === "running" ? "phase_1_running" : result?.status || "phase_1_running";
}

export async function runPlanningPhase(initialState) {
  const threadId = initialState.graph_thread_id || initialState.pipeline_id;
  const graph = getGraph();
  const config = graphConfig(threadId);

  const result = await graph.invoke(
    {
      ...initialState,
      phase: "planning",
      status: "phase_1_running",
      agent_logs: [],
    },
    config,
  );

  const status = await resolveStatus(threadId, result);
  const current_agent =
    status === "awaiting_target_clarification" || status === "awaiting_code_clarification"
      ? "CLARIFY"
      : status === "awaiting_gate_1"
        ? "GATE_1"
        : result.current_agent;
  return { ...result, status, current_agent };
}

export async function retryDevelopmentPhase(pipeline) {
  const threadId = pipeline.graph_thread_id || pipeline.id;
  const graph = getGraph();
  const config = graphConfig(threadId);

  await graph.updateState(config, {
    values: {
      pipeline_id: pipeline.id,
      jira_task: pipeline.jira_task,
      knowledge_context: pipeline.knowledge_context,
      technical_spec: pipeline.technical_spec,
      test_cases: pipeline.test_cases,
      test_suite_name: pipeline.test_suite_name,
      gate_1_approved: true,
      gate_1_feedback: pipeline.gate_1_feedback,
      retry_feedback: pipeline.retry_feedback,
      phase: "development",
      status: "phase_2_running",
      frontend_code: null,
      backend_code: null,
      test_code: null,
      workspace_files: [],
      gate_2_approved: null,
      gate_2_feedback: null,
      code_review: null,
      test_execution: null,
      execution_report: null,
      git_branch: pipeline.git_branch,
      repo_source: pipeline.repo_source,
      agent_logs: [],
    },
    asNode: "dev_parallel",
  });

  const result = await graph.invoke(null, config);
  const status = await resolveStatus(threadId, result);
  const current_agent = status === "awaiting_gate_2" ? "GATE_2" : result.current_agent;
  return { ...result, status, current_agent };
}

export async function resumeGate1(threadId, { approved, feedback = null }) {
  const graph = getGraph();
  const config = graphConfig(threadId);
  const { Command } = await import("@langchain/langgraph");

  const result = await graph.invoke(
    new Command({ resume: { approved, feedback } }),
    config,
  );

  const status = await resolveStatus(threadId, result);
  const current_agent =
    status === "awaiting_gate_2"
      ? "GATE_2"
      : status === "phase_2_running"
        ? result.current_agent
        : status === "awaiting_gate_1"
          ? "GATE_1"
          : result.current_agent;

  return { ...result, status, current_agent };
}

export async function resumeGate2(threadId, { approved, feedback = null }) {
  const graph = getGraph();
  const config = graphConfig(threadId);
  const { Command } = await import("@langchain/langgraph");

  const result = await graph.invoke(
    new Command({ resume: { approved, feedback } }),
    config,
  );

  const status = await resolveStatus(threadId, result);
  const current_agent =
    status === "awaiting_gate_2"
      ? "GATE_2"
      : status === "phase_2_complete"
        ? "GATE_2"
        : result.current_agent;

  return { ...result, status, current_agent };
}

export async function resumeTargetClarify(threadId, decision) {
  const graph = getGraph();
  const config = graphConfig(threadId);
  const { Command } = await import("@langchain/langgraph");

  const result = await graph.invoke(new Command({ resume: decision }), config);
  const status = await resolveStatus(threadId, result);
  const current_agent =
    status === "awaiting_target_clarification" || status === "awaiting_code_clarification"
      ? "CLARIFY"
      : status === "awaiting_gate_1"
        ? "GATE_1"
        : result.current_agent;
  return { ...result, status, current_agent };
}

export async function resumeCodeWriteClarify(threadId, decision) {
  const graph = getGraph();
  const config = graphConfig(threadId);
  const { Command } = await import("@langchain/langgraph");

  const result = await graph.invoke(new Command({ resume: decision }), config);
  const status = await resolveStatus(threadId, result);
  const current_agent =
    status === "awaiting_gate_2"
      ? "GATE_2"
      : status === "awaiting_code_clarification"
        ? "CLARIFY"
        : result.current_agent;
  return { ...result, status, current_agent };
}

export async function getGraphState(threadId) {
  const snapshot = await snapshotFor(threadId);
  return snapshot?.values || null;
}
