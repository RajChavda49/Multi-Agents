import { Annotation, StateGraph, START, END, interrupt, MemorySaver } from "@langchain/langgraph";
import { runA1Knowledge } from "./agents/a1-knowledge.js";
import { runA2DevPlan } from "./agents/a2-dev-plan.js";
import { runA3TestCases } from "./agents/a3-test-cases.js";
import { runA4Frontend } from "./agents/a4-frontend.js";
import { runA5Backend } from "./agents/a5-backend.js";
import { runA6TestCoding } from "./agents/a6-test-coding.js";
import { runA7CodeReview } from "./agents/a7-code-review.js";
import { runA8TestExec } from "./agents/a8-test-exec.js";
import { runA9Report } from "./agents/a9-report.js";
import { writeCodeFiles, listWorkspaceFiles } from "./workspace.js";
import { ensureRepoReady } from "../integrations/repo-target.js";

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

async function a1Node(state) {
  return {
    ...(await runA1Knowledge(state)),
    status: "running",
    phase: "planning",
    current_agent: "A1",
  };
}

async function a2Node(state) {
  return {
    ...(await runA2DevPlan(state)),
    status: "running",
    current_agent: "A2",
  };
}

async function a3Node(state) {
  return {
    ...(await runA3TestCases(state)),
    status: "running",
    current_agent: "A3",
  };
}

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

  const [a4, a5, a6] = await Promise.all([
    runA4Frontend(state),
    runA5Backend(state),
    runA6TestCoding(state),
  ]);

  const allFiles = [
    ...(a4.frontend_code?.files || []),
    ...(a5.backend_code?.files || []),
    ...(a6.test_code?.files || []),
  ];

  const writeResult = writeCodeFiles(state.pipeline_id, allFiles);
  const workspace_files = listWorkspaceFiles(state.pipeline_id);

  return {
    phase: "development",
    status: "phase_2_running",
    current_agent: "A4-A6",
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
  return {
    ...(await runA7CodeReview(state)),
    status: "phase_2_running",
    phase: "development",
  };
}

async function a8Node(state) {
  return {
    ...(await runA8TestExec(state)),
    status: "phase_2_running",
    phase: "development",
  };
}

async function a9Node(state) {
  return {
    ...(await runA9Report(state)),
    status: "phase_2_complete",
    phase: "development",
    current_agent: "A9",
  };
}

async function gate2Node(state) {
  const decision = interrupt({
    gate: "GATE_2",
    message: "Review generated code and test scripts before automated review and test execution.",
    pipeline_id: state.pipeline_id,
    jira_key: state.jira_task?.key,
    test_cases: state.test_cases,
    test_suite_name: state.test_suite_name,
    frontend_code: state.frontend_code,
    backend_code: state.backend_code,
    test_code: state.test_code,
    workspace_files: state.workspace_files,
  });

  const approved = decision?.approved === true;

  return {
    gate_2_approved: approved,
    gate_2_feedback: decision?.feedback || null,
    status: approved ? "gate_2_approved" : "gate_2_rejected",
    current_agent: "GATE_2",
    agent_logs: [
      {
        agent: "GATE_2",
        name: "Human Gate 2",
        status: approved ? "approved" : "rejected",
        completed_at: new Date().toISOString(),
        output_summary: approved
          ? "Code & test scripts approved — running review & test execution"
          : `Rejected: ${decision?.feedback || "no feedback"}`,
      },
    ],
  };
}

function routeAfterGate2(state) {
  return state.gate_2_approved ? "a7_code_review" : END;
}

function buildGraph() {
  const graph = new StateGraph(PipelineAnnotation)
    .addNode("a1_knowledge", a1Node)
    .addNode("a2_dev_plan", a2Node)
    .addNode("a3_test_cases", a3Node)
    .addNode("gate_1", gate1Node)
    .addNode("dev_parallel", devParallelNode)
    .addNode("a7_code_review", a7Node)
    .addNode("a8_test_exec", a8Node)
    .addNode("a9_report", a9Node)
    .addNode("gate_2", gate2Node)
    .addEdge(START, "a1_knowledge")
    .addEdge("a1_knowledge", "a2_dev_plan")
    .addEdge("a2_dev_plan", "a3_test_cases")
    .addEdge("a3_test_cases", "gate_1")
    .addConditionalEdges("gate_1", routeAfterGate1, ["dev_parallel", END])
    .addEdge("dev_parallel", "gate_2")
    .addConditionalEdges("gate_2", routeAfterGate2, ["a7_code_review", END])
    .addEdge("a7_code_review", "a8_test_exec")
    .addEdge("a8_test_exec", "a9_report")
    .addEdge("a9_report", END);

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

export function graphConfig(pipelineId) {
  return { configurable: { thread_id: pipelineId } };
}

async function snapshotFor(pipelineId) {
  const graph = getGraph();
  return graph.getState(graphConfig(pipelineId));
}

export async function isAwaitingGate1(pipelineId) {
  const snapshot = await snapshotFor(pipelineId);
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
  if (await isAwaitingGate1(pipelineId)) return "awaiting_gate_1";
  if (await isAwaitingGate2(pipelineId)) return "awaiting_gate_2";
  if (result?.status === "phase_2_complete") return "phase_2_complete";
  if (result?.gate_2_approved === false) return "gate_2_rejected";
  if (result?.gate_1_approved === false) return "gate_1_rejected";
  if (result?.phase === "development" || result?.gate_1_approved === true) {
    return "phase_2_running";
  }
  if (result?.phase === "planning") return "phase_1_running";
  return result?.status === "running" ? "phase_1_running" : result?.status || "phase_1_running";
}

export async function runPlanningPhase(initialState) {
  const graph = getGraph();
  const config = graphConfig(initialState.pipeline_id);

  const result = await graph.invoke(
    {
      ...initialState,
      phase: "planning",
      status: "phase_1_running",
      agent_logs: [],
    },
    config,
  );

  const status = await resolveStatus(initialState.pipeline_id, result);
  return { ...result, status, current_agent: status === "awaiting_gate_1" ? "GATE_1" : result.current_agent };
}

export async function resumeGate1(pipelineId, { approved, feedback = null }) {
  const graph = getGraph();
  const config = graphConfig(pipelineId);
  const { Command } = await import("@langchain/langgraph");

  const result = await graph.invoke(
    new Command({ resume: { approved, feedback } }),
    config,
  );

  const status = await resolveStatus(pipelineId, result);
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

export async function resumeGate2(pipelineId, { approved, feedback = null }) {
  const graph = getGraph();
  const config = graphConfig(pipelineId);
  const { Command } = await import("@langchain/langgraph");

  const result = await graph.invoke(
    new Command({ resume: { approved, feedback } }),
    config,
  );

  const status = await resolveStatus(pipelineId, result);
  const current_agent =
    status === "awaiting_gate_2"
      ? "GATE_2"
      : status === "phase_2_complete"
        ? "A9"
        : result.current_agent;

  return { ...result, status, current_agent };
}

export async function getGraphState(pipelineId) {
  const snapshot = await snapshotFor(pipelineId);
  return snapshot?.values || null;
}
