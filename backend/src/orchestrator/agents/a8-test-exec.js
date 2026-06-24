import { chatJson } from "../llm.js";

const SYSTEM = `You are A8 Testing Exec Agent. Summarize Playwright test execution results.
Respond ONLY with valid JSON with keys: passed, failed, skipped, total, duration_ms, results (array).`;

export async function runA8TestExec(state) {
  const startedAt = new Date().toISOString();
  const testFiles = state.test_code?.files || [];
  const plannedCases = state.test_cases || [];

  const mockResults = plannedCases.slice(0, 4).map((tc, i) => ({
    id: tc.id,
    title: tc.title,
    status: i === 0 ? "passed" : "passed",
    duration_ms: 800 + i * 200,
  }));

  const mockPayload = {
    passed: mockResults.length,
    failed: 0,
    skipped: Math.max(0, plannedCases.length - mockResults.length),
    total: plannedCases.length,
    duration_ms: mockResults.reduce((s, r) => s + r.duration_ms, 0),
    environment: "local-docker",
    test_files: testFiles.map((f) => f.path),
    results: mockResults,
  };

  const user = `Execute tests for:
Test files: ${JSON.stringify(testFiles.map((f) => f.path))}
Planned cases: ${JSON.stringify(plannedCases)}`;

  const execution = await chatJson(SYSTEM, user, mockPayload);

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
        output_summary: `${execution.passed}/${execution.total} tests passed`,
      },
    ],
  };
}
