import { chatJsonPlanning } from "../llm.js";
import { getRetryPromptContext } from "../retry-context.js";
import { reportAgentActivity } from "../../services/pipeline-progress.js";
import { formatJiraBlock, formatSpecForA3 } from "../prompt-format.js";

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
- Cover every acceptance criterion with at least one case
- For change_scope "short" / ui_copy: prefer visual/e2e cases, skip API tests if backend_needed is false
- Keep 3–8 focused cases, not an exhaustive suite`;

export async function runA3TestCases(state) {
  const task = state.jira_task;
  const spec = state.technical_spec;
  const startedAt = new Date().toISOString();
  reportAgentActivity(state.pipeline_id, { current_agent: "A3" });

  const user = `${getRetryPromptContext(state)}${formatJiraBlock(task)}

=== TECHNICAL SPEC ===
${JSON.stringify(formatSpecForA3(spec), null, 2)}

Generate test cases aligned with the spec.`;

  const testPlan = await chatJsonPlanning(SYSTEM, user, {
    agent: "A3",
    pipeline_id: state.pipeline_id,
    num_predict: 900,
    num_ctx: 4096,
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
