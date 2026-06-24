import { chatJsonCoding } from "../llm.js";
import { getRetryPromptContext } from "../retry-context.js";
import { formatJiraBlock, formatSpecForCoding } from "../prompt-format.js";

const SYSTEM = `You are A6 Test Coding Agent. Write tests for the planned changes.

Respond ONLY with valid JSON:
{
  "files": [{ "path": "relative/path", "content": "source code" }],
  "mapped_cases": ["TC-001"]
}

Rules:
- If backend_needed is false, write frontend/visual/e2e tests only — no API test files
- For change_scope "short": 1–2 focused test files maximum
- Map each file to case IDs in mapped_cases
- Match the project's test folder conventions if known`;

export async function runA6TestCoding(state) {
  const spec = state.technical_spec;
  const testCases = state.test_cases || [];
  const task = state.jira_task;
  const knowledge = state.knowledge_context;
  const startedAt = new Date().toISOString();

  const user = `${getRetryPromptContext(state)}${formatJiraBlock(task)}

=== SPEC ===
${JSON.stringify(formatSpecForCoding(spec, knowledge), null, 2)}

=== TEST CASES ===
${JSON.stringify(testCases.slice(0, 8), null, 2)}

Generate test files only (backend agent skipped for this pipeline).`;

  const result = await chatJsonCoding(SYSTEM, user, { agent: "A6", pipeline_id: state.pipeline_id });

  return {
    test_code: result,
    agent_logs: [
      {
        agent: "A6",
        name: "Test Coding Agent",
        status: "completed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_summary: `${(result.files || []).length} test file(s)`,
      },
    ],
  };
}
