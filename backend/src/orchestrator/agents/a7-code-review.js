import { chatJson } from "../llm.js";
import { runRepoLint, isTargetRepoConfigured, getTargetRepoPath } from "../../integrations/local-repo.js";

const SYSTEM = `You are A7 Code Review Agent. Review generated code against the spec and real lint output when provided.
Respond ONLY with valid JSON:
{
  "summary": "string",
  "approved": boolean,
  "issues": [{ "severity": "low|medium|high", "file": "path", "message": "string" }],
  "security_notes": ["string"],
  "lint_results": { "eslint": {}, "typescript": {}, "target_repo": "path or null" }
}`;

export async function runA7CodeReview(state) {
  const startedAt = new Date().toISOString();
  const lintRun = isTargetRepoConfigured() ? runRepoLint() : null;

  const user = `Review this generated codebase. Use the real lint output below when deciding approved and issues.

Target repo lint (real):
${JSON.stringify(lintRun, null, 2)}
Target repo path: ${isTargetRepoConfigured() ? getTargetRepoPath() : "not connected"}

Technical spec:
${JSON.stringify(state.technical_spec, null, 2)}

Frontend:
${JSON.stringify(state.frontend_code, null, 2)}

Backend:
${JSON.stringify(state.backend_code, null, 2)}

Tests:
${JSON.stringify(state.test_code, null, 2)}`;

  const review = await chatJson(SYSTEM, user, { agent: "A7", pipeline_id: state.pipeline_id });

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
