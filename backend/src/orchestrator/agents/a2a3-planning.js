import { chatJsonPlanning } from "../llm.js";
import { getRetryPromptContext } from "../retry-context.js";
import { reportAgentActivity } from "../../services/pipeline-progress.js";
import { formatJiraContext, formatKnowledgeForA2 } from "../prompt-format.js";
import { formatDeliverablesForPrompt } from "../task-deliverables.js";

const SYSTEM = `You are A2+A3 — senior tech lead + QA lead in ONE reasoning pass.

Read the Jira ticket and A1 analysis. Produce BOTH the implementation spec AND test cases together so they stay aligned.

Respond ONLY with valid JSON:
{
  "technical_spec": {
    "title": "string",
    "overview": "string",
    "change_scope": "short|medium|long",
    "change_type": "ui_copy|ui_component|styling|api|data_model|full_feature|bugfix|other",
    "backend_needed": false,
    "acceptance_criteria": ["from Jira, refined — include EVERY UI area mentioned"],
    "frontend_tasks": ["one task per deliverable — e.g. header AND footer each get their own task"],
    "backend_tasks": [],
    "rollout_notes": "how to verify ALL deliverables"
  },
  "test_plan": {
    "suite_name": "string",
    "cases": [{
      "id": "TC-001",
      "title": "string",
      "type": "e2e|api|visual|unit",
      "priority": "P0|P1|P2",
      "preconditions": ["string"],
      "steps": ["string"],
      "expected": "string"
    }]
  }
}

Rules:
- If task_deliverables lists header AND footer → frontend_tasks MUST include BOTH (separate tasks, separate files)
- Cover every acceptance criterion with at least one test case
- backend_tasks must be [] when backend_needed is false
- Think step by step: list all UI areas in the ticket before writing tasks`;

export async function runA2A3Planning(state) {
  const task = state.jira_task;
  const knowledge = state.knowledge_context;
  const startedAt = new Date().toISOString();
  reportAgentActivity(state.pipeline_id, { current_agent: "A2-A3" });

  const jira = formatJiraContext(task);
  const deliverablesBlock = formatDeliverablesForPrompt(knowledge?.task_deliverables);

  const user = `${getRetryPromptContext(state)}${jira.text}

=== TASK DELIVERABLES (implement ALL — do not stop after the first) ===
${deliverablesBlock}

=== A1 ANALYSIS ===
${JSON.stringify(formatKnowledgeForA2(knowledge), null, 2)}

Produce technical_spec + test_plan. Every deliverable above needs a frontend_task and at least one test case.`;

  const raw = await chatJsonPlanning(SYSTEM, user, {
    agent: "A2-A3",
    pipeline_id: state.pipeline_id,
    num_predict: 1200,
    num_ctx: 4096,
    images: jira.images,
  });

  const spec = raw.technical_spec || raw;
  const testPlan = raw.test_plan || { cases: raw.cases, suite_name: raw.suite_name };

  if (!spec.backend_needed) {
    spec.backend_tasks = [];
  }

  const caseCount = (testPlan.cases || []).length;

  return {
    technical_spec: spec,
    test_cases: testPlan.cases || [],
    test_suite_name: testPlan.suite_name || spec.title,
    current_agent: "A2-A3",
    agent_logs: [
      {
        agent: "A2",
        name: "Dev Plan Agent",
        status: "completed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_summary: `${spec.change_scope || "?"} · ${(spec.frontend_tasks || []).length} frontend task(s)`,
      },
      {
        agent: "A3",
        name: "Test Case Agent",
        status: "completed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_summary: `${caseCount} test case(s)`,
      },
    ],
  };
}
