import { chatJsonPlanning } from "../llm.js";
import { getRetryPromptContext } from "../retry-context.js";
import { reportAgentActivity } from "../../services/pipeline-progress.js";
import { formatJiraContext, formatSpecForA3 } from "../prompt-format.js";
import { formatDeliverablesForPrompt } from "../task-deliverables.js";

const SYSTEM = `You are A3 Test Case Agent. Create test cases from the technical specification.

Respond ONLY with valid JSON:
{
  "suite_name": "string",
  "cases": [{
    "id": "TC-001",
    "title": "string",
    "type": "e2e|api|visual|unit",
    "priority": "P0|P1|P2",
    "preconditions": ["string"],
    "steps": ["string"],
    "expected": "string"
  }]
}

Rules:
- Cover every acceptance criterion and every task deliverable with at least one case
- Header + footer deliverables → separate test cases for each
- For ui_copy / short scope: prefer visual/e2e; skip API tests if backend_needed is false
- Write as many cases as the spec requires — quality over brevity`;

export async function runA3TestCases(state) {
  const task = state.jira_task;
  const spec = state.technical_spec;
  const knowledge = state.knowledge_context;
  const startedAt = new Date().toISOString();
  reportAgentActivity(state.pipeline_id, { current_agent: "A3" });

  const jira = formatJiraContext(task);

  const user = `${getRetryPromptContext(state)}${jira.text}

=== TASK DELIVERABLES ===
${formatDeliverablesForPrompt(knowledge?.task_deliverables)}

=== TECHNICAL SPEC ===
${JSON.stringify(formatSpecForA3(spec), null, 2)}

Generate test cases aligned with the spec and all deliverables.`;

  const testPlan = await chatJsonPlanning(SYSTEM, user, {
    agent: "A3",
    pipeline_id: state.pipeline_id,
    images: jira.images,
  });

  return {
    test_cases: testPlan.cases || [],
    test_suite_name: testPlan.suite_name,
    current_agent: "A3",
    agent_logs: [
      {
        agent: "A3",
        name: "Test Case Agent",
        status: "completed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_summary: `${(testPlan.cases || []).length} cases · ${spec.change_scope || "?"} scope`,
      },
    ],
  };
}
