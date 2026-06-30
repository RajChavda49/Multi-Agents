import { chatJsonPlanning } from "../llm.js";
import { getRetryPromptContext } from "../retry-context.js";
import { reportAgentActivity } from "../../services/pipeline-progress.js";
import { formatJiraContext, formatKnowledgeForA2 } from "../prompt-format.js";
import { formatDeliverablesForPrompt } from "../task-deliverables.js";

const SYSTEM = `You are A2 Dev Plan Agent. Turn Jira + A1 analysis into a concrete implementation plan.

Respond ONLY with valid JSON:
{
  "title": "string",
  "overview": "string",
  "change_scope": "short|medium|long",
  "change_type": "ui_copy|ui_component|styling|api|data_model|full_feature|bugfix|other",
  "project_scope": "frontend|backend|fullstack",
  "backend_needed": false,
  "acceptance_criteria": ["from Jira — include EVERY UI area"],
  "frontend_tasks": ["one task per deliverable — header AND footer = two tasks"],
  "backend_tasks": [],
  "data_model": { "entities": [], "fields": [] },
  "api_contracts": [],
  "rollout_notes": "how to verify ALL deliverables"
}

Rules:
- project_scope must match A1 — frontend/backend/fullstack
- task_deliverables lists every UI part — each needs its own frontend_task
- Honor A1 change_scope unless Jira contradicts
- backend_tasks must be [] when backend_needed is false`;

export async function runA2DevPlan(state) {
  const task = state.jira_task;
  const knowledge = state.knowledge_context;
  const startedAt = new Date().toISOString();
  reportAgentActivity(state.pipeline_id, { current_agent: "A2" });

  const jira = formatJiraContext(task);

  const user = `${getRetryPromptContext(state)}${jira.text}

=== TASK DELIVERABLES (each needs a frontend_task) ===
${formatDeliverablesForPrompt(knowledge?.task_deliverables)}

=== A1 ANALYSIS ===
${JSON.stringify(formatKnowledgeForA2(knowledge), null, 2)}

Write the dev plan. Be specific about which files to create or edit.`;

  const spec = await chatJsonPlanning(SYSTEM, user, {
    agent: "A2",
    pipeline_id: state.pipeline_id,
    images: jira.images,
  });

  if (!spec.backend_needed) {
    spec.backend_tasks = [];
    spec.api_contracts = spec.api_contracts || [];
  }
  if (!spec.project_scope) {
    spec.project_scope = spec.backend_needed
      ? "fullstack"
      : knowledge?.project_scope || "frontend";
  }

  return {
    technical_spec: spec,
    current_agent: "A2",
    agent_logs: [
      {
        agent: "A2",
        name: "Dev Plan Agent",
        status: "completed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_summary: `${spec.project_scope || "frontend"} · backend ${spec.backend_needed ? "yes" : "no"} — ${(spec.overview || spec.title || "").slice(0, 80)}`,
      },
    ],
  };
}
