import { Annotation, StateGraph, START, END, interrupt, MemorySaver } from "@langchain/langgraph";
import { runA1Knowledge } from "./agents/a1-knowledge.js";
import { runA2DevPlan } from "./agents/a2-dev-plan.js";
import { runA3TestCases } from "./agents/a3-test-cases.js";

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
    status: approved ? "gate_1_approved" : "gate_1_rejected",
    current_agent: "GATE_1",
    agent_logs: [
      {
        agent: "GATE_1",
        name: "Human Gate 1",
        status: approved ? "approved" : "rejected",
        completed_at: new Date().toISOString(),
        output_summary: approved
          ? "Spec & test plan approved for development"
          : `Rejected: ${decision?.feedback || "no feedback"}`,
      },
    ],
  };
}

function buildGraph() {
  const graph = new StateGraph(PipelineAnnotation)
    .addNode("a1_knowledge", a1Node)
    .addNode("a2_dev_plan", a2Node)
    .addNode("a3_test_cases", a3Node)
    .addNode("gate_1", gate1Node)
    .addEdge(START, "a1_knowledge")
    .addEdge("a1_knowledge", "a2_dev_plan")
    .addEdge("a2_dev_plan", "a3_test_cases")
    .addEdge("a3_test_cases", "gate_1")
    .addEdge("gate_1", END);

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

export async function isAwaitingGate1(pipelineId) {
  const graph = getGraph();
  const snapshot = await graph.getState(graphConfig(pipelineId));
  const pendingGate = snapshot?.next?.includes("gate_1");
  const hasInterrupt = snapshot?.tasks?.some(
    (task) => task.name === "gate_1" && task.interrupts?.length > 0,
  );
  return pendingGate || hasInterrupt;
}

export async function runPlanningPhase(initialState) {
  const graph = getGraph();
  const config = graphConfig(initialState.pipeline_id);

  const result = await graph.invoke(
    {
      ...initialState,
      phase: "planning",
      status: "running",
      agent_logs: [],
    },
    config,
  );

  const interrupted = await isAwaitingGate1(initialState.pipeline_id);

  if (interrupted) {
    return {
      ...result,
      status: "awaiting_gate_1",
      current_agent: "GATE_1",
    };
  }

  return result;
}

export async function resumeGate1(pipelineId, { approved, feedback = null }) {
  const graph = getGraph();
  const config = graphConfig(pipelineId);

  const { Command } = await import("@langchain/langgraph");
  const result = await graph.invoke(
    new Command({ resume: { approved, feedback } }),
    config,
  );

  return result;
}

export async function getGraphState(pipelineId) {
  const graph = getGraph();
  const snapshot = await graph.getState(graphConfig(pipelineId));
  return snapshot?.values || null;
}
