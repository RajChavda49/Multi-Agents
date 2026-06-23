import { chatJson } from "../llm.js";

const SYSTEM = `You are A3 Test Case Agent. Generate a comprehensive test case library
from the technical specification. Respond ONLY with valid JSON.`;

export async function runA3TestCases(state) {
  const spec = state.technical_spec;
  const startedAt = new Date().toISOString();

  const mockPayload = {
    suite_name: `${spec.title || "Feature"} — Phase 1 Test Plan`,
    cases: [
      {
        id: "TC-001",
        title: "Happy path — create record",
        type: "e2e",
        priority: "P0",
        preconditions: ["User is authenticated", "Staging env is up"],
        steps: [
          "Navigate to feature page",
          "Fill required fields",
          "Submit form",
        ],
        expected: "Record appears in list with success toast",
      },
      {
        id: "TC-002",
        title: "Validation — required fields",
        type: "e2e",
        priority: "P1",
        preconditions: ["User is on feature page"],
        steps: ["Leave required field empty", "Click submit"],
        expected: "Inline validation errors shown; no API call fired",
      },
      {
        id: "TC-003",
        title: "API — GET returns 200",
        type: "api",
        priority: "P0",
        preconditions: ["Seed data exists"],
        steps: ["GET /api/feature"],
        expected: "200 with paginated JSON body",
      },
      {
        id: "TC-004",
        title: "Responsive layout",
        type: "visual",
        priority: "P2",
        preconditions: ["Page loaded at 375px viewport"],
        steps: ["Capture screenshot", "Compare to baseline"],
        expected: "No layout overflow or clipped controls",
      },
    ],
  };

  const user = `Technical specification:
${JSON.stringify(spec, null, 2)}`;

  const testPlan = await chatJson(SYSTEM, user, mockPayload);

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
        output_summary: `${(testPlan.cases || []).length} test cases generated`,
      },
    ],
  };
}
