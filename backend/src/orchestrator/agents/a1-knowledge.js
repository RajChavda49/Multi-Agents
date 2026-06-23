import { chatJson } from "../llm.js";

const SYSTEM = `You are A1 Knowledge Agent. Analyze the Jira task and produce structured context
for planning: relevant modules, constraints, dependencies, and risks.
Respond ONLY with valid JSON matching the schema.`;

export async function runA1Knowledge(state) {
  const task = state.jira_task;
  const startedAt = new Date().toISOString();

  const mockPayload = {
    summary: `Knowledge context for ${task.key}`,
    relevant_modules: ["src/components", "src/api", "src/hooks"],
    constraints: [
      "Use existing design system tokens",
      "Maintain backward-compatible API contracts",
    ],
    dependencies: ["auth middleware", "shared UI primitives"],
    risks: ["Cross-browser layout edge cases", "API rate limits on bulk operations"],
    documentation_refs: ["README.md", "docs/architecture.md"],
    codebase_notes:
      "Feature should extend existing patterns; no new state management library.",
  };

  const user = `Jira Task:
Key: ${task.key}
Summary: ${task.summary}
Description: ${task.description || "(none)"}
Type: ${task.issue_type || "Task"}
Priority: ${task.priority || "Medium"}`;

  const knowledge = await chatJson(SYSTEM, user, mockPayload);

  return {
    knowledge_context: knowledge,
    current_agent: "A1",
    agent_logs: [
      {
        agent: "A1",
        name: "Knowledge Agent",
        status: "completed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_summary: knowledge.summary,
      },
    ],
  };
}
