import { chatJsonPlanning } from "../llm.js";
import { getRetryPromptContext } from "../retry-context.js";
import { reportAgentActivity } from "../../services/pipeline-progress.js";
import { formatJiraBlock, formatKnowledgeForA2 } from "../prompt-format.js";

const SYSTEM = `You are A2 Dev Plan Agent. Turn Jira + A1 analysis into a concrete implementation plan.

Respond ONLY with valid JSON:
{
  "title": "string",
  "overview": "string",
  "change_scope": "short|medium|long",
  "change_type": "ui_copy|ui_component|styling|api|data_model|full_feature|bugfix|other",
  "backend_needed": false,
  "acceptance_criteria": ["from Jira, refined"],
  "frontend_tasks": ["specific file-level tasks"],
  "backend_tasks": ["empty array if backend_needed is false"],
  "data_model": { "entities": [], "fields": [] },
  "api_contracts": [],
  "rollout_notes": "how to verify"
}

Rules:
- Honor A1 change_scope and backend_needed unless Jira clearly contradicts
- For change_scope "short": frontend_tasks must name exact files from A1 files_to_edit and the exact string/UI change
- Use ONLY paths from files_to_edit — never invent src/components paths if the repo uses components/
- backend_tasks must be [] when backend_needed is false
- Do not invent API work for UI-only copy changes
- If files_to_edit is empty, say so in rollout_notes — do not guess file paths`;

export async function runA2DevPlan(state) {
  const task = state.jira_task;
  const knowledge = state.knowledge_context;
  const startedAt = new Date().toISOString();
  reportAgentActivity(state.pipeline_id, { current_agent: "A2" });

  const user = `${getRetryPromptContext(state)}${formatJiraBlock(task)}

=== A1 ANALYSIS ===
${JSON.stringify(formatKnowledgeForA2(knowledge), null, 2)}

Write the dev plan. Be specific about which files to edit.`;

  const spec = await chatJsonPlanning(SYSTEM, user, {
    agent: "A2",
    pipeline_id: state.pipeline_id,
    num_predict: 800,
    num_ctx: 4096,
  });

  if (!spec.backend_needed) {
    spec.backend_tasks = [];
    spec.api_contracts = spec.api_contracts || [];
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
        output_summary: `${spec.change_scope || "?"} · backend ${spec.backend_needed ? "yes" : "no"} — ${(spec.overview || spec.title || "").slice(0, 80)}`,
      },
    ],
  };
}
