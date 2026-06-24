import { chatJson } from "../llm.js";

const SYSTEM = `You are A8 Testing Exec Agent. Analyze the generated test files and test plan.
Note: tests are NOT executed automatically — produce a structured readiness report and what would be run.
Respond ONLY with valid JSON:
{
  "passed": number,
  "failed": number,
  "skipped": number,
  "total": number,
  "duration_ms": number,
  "environment": "string",
  "test_files": ["paths"],
  "results": [{ "id": "TC-001", "title": "string", "status": "pending|passed|failed", "duration_ms": number, "note": "string" }],
  "execution_note": "string explaining tests were not auto-run unless noted otherwise"
}`;

export async function runA8TestExec(state) {
  const startedAt = new Date().toISOString();
  const testFiles = state.test_code?.files || [];
  const plannedCases = state.test_cases || [];

  const user = `Test plan cases:
${JSON.stringify(plannedCases, null, 2)}

Generated test files:
${JSON.stringify(testFiles, null, 2)}

Report readiness and map each planned case to generated coverage. Mark status "pending" unless real execution data is provided.`;

  const execution = await chatJson(SYSTEM, user, { agent: "A8", pipeline_id: state.pipeline_id });

  return {
    test_execution: execution,
    current_agent: "A8",
    agent_logs: [
      {
        agent: "A8",
        name: "Testing Exec Agent",
        status: execution.failed === 0 ? "completed" : "failed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_summary: execution.execution_note || `${execution.passed}/${execution.total} tests`,
      },
    ],
  };
}
