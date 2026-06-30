/** Compact summaries for A7–A9 — avoid dumping full file bodies into LLM prompts. */

export function summarizeGeneratedFiles(codeBundle) {
  const files = codeBundle?.files || [];
  return files.map((f) => ({
    path: f.path,
    write_mode: f.write_mode || "unknown",
    chars: (f.content || "").length,
    preview: (f.content || "").slice(0, 200).replace(/\n/g, " "),
  }));
}

export function summarizeSpecForReview(spec) {
  if (!spec) return {};
  return {
    title: spec.title,
    change_scope: spec.change_scope,
    change_type: spec.change_type,
    backend_needed: spec.backend_needed,
    acceptance_criteria: (spec.acceptance_criteria || []).slice(0, 5),
    frontend_tasks: (spec.frontend_tasks || []).slice(0, 4),
  };
}

export function summarizeTestPlan(testCases = []) {
  return testCases.slice(0, 12).map((tc) => ({
    id: tc.id,
    title: tc.title,
    type: tc.type,
    priority: tc.priority,
  }));
}

export function buildTestExecutionSummary(state) {
  const testFiles = state.test_code?.files || [];
  const cases = state.test_cases || [];
  const results = cases.map((tc) => ({
    id: tc.id,
    title: tc.title,
    status: "pending",
    duration_ms: 0,
    note: testFiles.length ? "Test file generated — not executed in CI" : "No test file mapped",
  }));

  return {
    passed: 0,
    failed: 0,
    skipped: 0,
    total: cases.length,
    duration_ms: 0,
    environment: "local-sdlc-agent",
    test_files: testFiles.map((f) => f.path),
    results,
    execution_note: `${testFiles.length} test file(s) written. Automated run skipped for speed — run npm test locally.`,
  };
}
