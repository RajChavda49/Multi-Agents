import { chatJson } from "../llm.js";
import { getRepoPromptContext } from "../../integrations/local-repo.js";

const SYSTEM = `You are A2 Dev Plan Agent. Generate a technical feature specification from
knowledge context and the Jira task. Respond ONLY with valid JSON.`;

export async function runA2DevPlan(state) {
  const task = state.jira_task;
  const knowledge = state.knowledge_context;
  const startedAt = new Date().toISOString();

  const mockPayload = {
    title: task.summary,
    overview: `Implement ${task.summary} using existing React/Next.js patterns.`,
    acceptance_criteria: [
      "User can complete the primary workflow end-to-end",
      "UI matches design system and is responsive",
      "API endpoints return correct status codes and payloads",
    ],
    frontend_tasks: [
      "Add route/page component",
      "Wire form state and validation",
      "Connect to API layer with loading/error states",
    ],
    backend_tasks: [
      "Add REST endpoint(s) with input validation",
      "Persist data with existing ORM patterns",
      "Add unit tests for service layer",
    ],
    data_model: {
      entities: ["FeatureRecord"],
      fields: ["id", "title", "status", "createdAt"],
    },
    api_contracts: [
      { method: "GET", path: "/api/feature", description: "List records" },
      { method: "POST", path: "/api/feature", description: "Create record" },
    ],
    rollout_notes: "Ship behind feature flag; enable in staging first.",
  };

  const user = `Jira: ${task.key} — ${task.summary}

${getRepoPromptContext(knowledge)}

Knowledge context:
${JSON.stringify(knowledge, null, 2)}`;

  const spec = await chatJson(SYSTEM, user, mockPayload);

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
        output_summary: spec.overview,
      },
    ],
  };
}
