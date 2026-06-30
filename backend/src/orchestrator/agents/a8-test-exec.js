import { chatJson } from "../llm.js";
import { summarizeGeneratedFiles, summarizeTestPlan } from "../prompt-compact.js";

const SYSTEM = `You are A8 Testing Exec Agent — QA lead who thinks independently about test strategy.

You receive a test plan and generated test files. Tests are NOT auto-run in this pipeline unless you determine they should be.

Respond ONLY with valid JSON:
{
  "passed": number,
  "failed": number,
  "skipped": number,
  "total": number,
  "duration_ms": number,
  "environment": "string",
  "test_files": ["paths"],
  "results": [{ "id": "TC-001", "title": "string", "status": "pending|passed|failed|skipped", "duration_ms": number, "note": "string" }],
  "execution_note": "string",
  "execution_decision": {
    "ran_tests": false,
    "reason": "why tests were or were not executed",
    "recommended_command": "npm test / npx playwright test / etc",
    "coverage_gaps": ["deliverables or AC not covered by tests"]
  }
}

Rules:
- Think: map each test case to a file; flag gaps (e.g. footer tests missing when footer was built)
- Status "pending" unless you have evidence tests ran
- If header AND footer were deliverables, verify test cases cover BOTH
- execution_decision.reason must explain your independent judgment`;

export async function runA8TestExec(state) {
  const startedAt = new Date().toISOString();
  const deliverables = state.knowledge_context?.task_deliverables || [];

  const user = `Task deliverables:
${deliverables.length ? deliverables.map((d) => `- ${d.label} (${d.id})`).join("\n") : "(see test plan)"}

Test plan:
${JSON.stringify(summarizeTestPlan(state.test_cases || []), null, 2)}

Generated tests:
${JSON.stringify(summarizeGeneratedFiles(state.test_code), null, 2)}

Frontend files produced:
${JSON.stringify(summarizeGeneratedFiles(state.frontend_code), null, 2)}

Analyze coverage, decide execution strategy, map cases to files.`;

  const execution = await chatJson(SYSTEM, user, {
    agent: "A8",
    pipeline_id: state.pipeline_id,
    planning: true,
    num_predict: 700,
    num_ctx: 4096,
  });

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
        output_summary:
          execution.execution_decision?.reason ||
          execution.execution_note ||
          `${execution.passed}/${execution.total} tests`,
      },
    ],
  };
}
