import { chatJson } from "../llm.js";

const SYSTEM = `You are A9 Report Agent. Produce a structured execution report for human Gate 2 review.
Respond ONLY with valid JSON with keys: title, overview, files_changed, test_summary, review_summary, risks, recommendation.`;

export async function runA9Report(state) {
  const startedAt = new Date().toISOString();
  const task = state.jira_task;
  const workspaceFiles = state.workspace_files || [];

  const mockPayload = {
    title: `Phase 2 Development Report — ${task.key}`,
    overview: `Completed parallel coding (A4/A5/A6), review (A7), and test execution (A8) for ${task.summary}.`,
    files_changed: workspaceFiles.map((f) => f.path),
    test_summary: state.test_execution,
    review_summary: state.code_review?.summary,
    risks: state.code_review?.issues?.map((i) => i.message) || [],
    recommendation: state.test_execution?.failed === 0 ? "approve_for_staging" : "needs_fixes",
    git_diff_summary: `${workspaceFiles.length} new files in workspace`,
  };

  const user = `Pipeline state summary:
Jira: ${task.key}
Review: ${JSON.stringify(state.code_review, null, 2)}
Tests: ${JSON.stringify(state.test_execution, null, 2)}
Files: ${JSON.stringify(workspaceFiles)}`;

  const report = await chatJson(SYSTEM, user, mockPayload);

  return {
    execution_report: report,
    current_agent: "A9",
    agent_logs: [
      {
        agent: "A9",
        name: "Report Agent",
        status: "completed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_summary: report.recommendation,
      },
    ],
  };
}
