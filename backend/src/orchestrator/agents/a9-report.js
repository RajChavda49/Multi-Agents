import { chatJson } from "../llm.js";

const SYSTEM = `You are A9 Report Agent. Produce a structured execution report for stakeholders.
Respond ONLY with valid JSON:
{
  "title": "string",
  "overview": "string",
  "files_changed": ["paths"],
  "test_summary": {},
  "review_summary": "string",
  "risks": ["string"],
  "recommendation": "approve_for_staging|needs_fixes|needs_review",
  "git_diff_summary": "string"
}`;

export async function runA9Report(state) {
  const startedAt = new Date().toISOString();
  const task = state.jira_task;
  const workspaceFiles = state.workspace_files || [];

  const user = `Jira: ${task.key} — ${task.summary}

Code review:
${JSON.stringify(state.code_review, null, 2)}

Test execution report:
${JSON.stringify(state.test_execution, null, 2)}

Workspace files written:
${JSON.stringify(workspaceFiles)}`;

  const report = await chatJson(SYSTEM, user, { agent: "A9", pipeline_id: state.pipeline_id });

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
