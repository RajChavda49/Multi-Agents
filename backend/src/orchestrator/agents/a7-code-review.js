import { chatJson } from "../llm.js";
import { runRepoLint, isTargetRepoConfigured, getTargetRepoPath } from "../../integrations/local-repo.js";
import {
  summarizeGeneratedFiles,
  summarizeSpecForReview,
} from "../prompt-compact.js";

const SYSTEM = `You are A7 Code Review Agent. Review generated code against the spec and real lint output.
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

  const user = `Review generated code (summaries + lint — full sources are on disk).

Lint:
${JSON.stringify(lintRun, null, 2)}
Repo: ${isTargetRepoConfigured() ? getTargetRepoPath() : "not connected"}

Spec:
${JSON.stringify(summarizeSpecForReview(state.technical_spec), null, 2)}

Frontend files:
${JSON.stringify(summarizeGeneratedFiles(state.frontend_code), null, 2)}

Backend files:
${JSON.stringify(summarizeGeneratedFiles(state.backend_code), null, 2)}

Test files:
${JSON.stringify(summarizeGeneratedFiles(state.test_code), null, 2)}

Approve if implementation matches spec and no high-severity lint issues.`;

  const review = await chatJson(SYSTEM, user, {
    agent: "A7",
    pipeline_id: state.pipeline_id,
    planning: true,
    num_predict: 600,
    num_ctx: 4096,
  });

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
