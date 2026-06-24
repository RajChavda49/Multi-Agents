import { chatJsonPlanning } from "../llm.js";
import { gatherKnowledgeContext } from "../../integrations/local-repo.js";
import { getRetryPromptContext } from "../retry-context.js";
import { reportAgentActivity } from "../../services/pipeline-progress.js";
import { formatJiraBlock, formatRepoScanForLlm } from "../prompt-format.js";

const SYSTEM = `You are A1 Knowledge Agent for an SDLC pipeline.

Read the Jira task and repo scan. Classify the work and identify where changes belong.

Respond ONLY with valid JSON:
{
  "summary": "one paragraph: what to do and where",
  "change_scope": "short|medium|long",
  "change_type": "ui_copy|ui_component|styling|api|data_model|full_feature|bugfix|other",
  "backend_needed": false,
  "backend_reason": "why backend is or is not needed",
  "relevant_modules": ["folder paths"],
  "constraints": ["implementation constraints"],
  "dependencies": ["libs or systems touched"],
  "risks": ["risks"],
  "documentation_refs": ["file paths if any"],
  "codebase_notes": "actionable notes for developers"
}

Rules for classification:
- change_scope "short": text/copy swap, single file, config tweak, < ~30 lines
- change_scope "medium": few files, one component flow
- change_scope "long": new feature, many files, API + UI
- backend_needed: true only if task requires API routes, server logic, DB, or auth — not for pure UI/footer text changes`;

export async function runA1Knowledge(state) {
  const task = state.jira_task;
  const startedAt = new Date().toISOString();
  reportAgentActivity(state.pipeline_id, {
    status: "phase_1_running",
    phase: "planning",
    current_agent: "A1",
  });

  const repoContext = gatherKnowledgeContext(task, state.retry_feedback);

  const user = `${getRetryPromptContext(state)}${formatJiraBlock(task)}

${formatRepoScanForLlm(repoContext)}

Analyze the task. Prefer content-matched files as edit targets.`;

  const knowledge = await chatJsonPlanning(SYSTEM, user, {
    agent: "A1",
    pipeline_id: state.pipeline_id,
    num_predict: 640,
    num_ctx: 4096,
  });

  return {
    knowledge_context: { ...repoContext, ...knowledge, repo_connected: repoContext.repo_connected },
    current_agent: "A1",
    agent_logs: [
      {
        agent: "A1",
        name: "Knowledge Agent",
        status: "completed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_summary: `${knowledge.change_scope || "?"} scope · backend ${knowledge.backend_needed ? "yes" : "no"} — ${(knowledge.summary || "").slice(0, 80)}`,
      },
    ],
  };
}
