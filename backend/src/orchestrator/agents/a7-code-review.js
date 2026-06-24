import { chatJson } from "../llm.js";
import { runRepoLint, isTargetRepoConfigured, getTargetRepoPath } from "../../integrations/local-repo.js";

const SYSTEM = `You are A7 Code Review Agent. Review merged frontend, backend, and test code.
Respond ONLY with valid JSON with keys: summary, issues (array), security_notes (array), lint_results, approved (boolean).`;

export async function runA7CodeReview(state) {
  const startedAt = new Date().toISOString();
  const allFiles = [
    ...(state.frontend_code?.files || []),
    ...(state.backend_code?.files || []),
    ...(state.test_code?.files || []),
  ];

  const lintRun = isTargetRepoConfigured() ? runRepoLint() : null;

  const mockPayload = {
    summary: `Reviewed ${allFiles.length} files across frontend, backend, and tests.`,
    approved: lintRun ? lintRun.passed !== false : true,
    issues: lintRun?.passed === false
      ? [{ severity: "high", file: "project", message: "npm run lint failed in target repo" }]
      : [{ severity: "low", file: allFiles[0]?.path || "unknown", message: "Consider extracting inline styles to design tokens" }],
    security_notes: [
      "Input validation present on POST routes via Zod",
      "No secrets hardcoded in generated files",
    ],
    lint_results: {
      eslint: lintRun?.ran
        ? { passed: lintRun.passed, output: lintRun.output }
        : { passed: true, errors: 0, warnings: 0, note: "No local repo lint run" },
      typescript: { passed: true, errors: 0 },
      target_repo: isTargetRepoConfigured() ? getTargetRepoPath() : null,
    },
  };

  const user = `Review this generated codebase:

Target repo lint:
${JSON.stringify(lintRun, null, 2)}

Frontend:
${JSON.stringify(state.frontend_code, null, 2)}

Backend:
${JSON.stringify(state.backend_code, null, 2)}

Tests:
${JSON.stringify(state.test_code, null, 2)}`;

  const review = await chatJson(SYSTEM, user, mockPayload);

  return {
    code_review: review,
    current_agent: "A7",
    agent_logs: [
      {
        agent: "A7",
        name: "Code Review Agent",
        status: review.approved ? "completed" : "failed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_summary: review.summary,
      },
    ],
  };
}
