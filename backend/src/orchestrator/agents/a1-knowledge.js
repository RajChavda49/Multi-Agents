import { chatJson } from "../llm.js";
import { gatherKnowledgeContext } from "../../integrations/local-repo.js";

const SYSTEM = `You are A1 Knowledge Agent. Analyze the Jira task and local codebase context to produce
structured planning context: relevant modules, constraints, dependencies, and risks.
Respond ONLY with valid JSON matching the schema.`;

export async function runA1Knowledge(state) {
  const task = state.jira_task;
  const startedAt = new Date().toISOString();

  const repoContext = gatherKnowledgeContext(task);

  const mockPayload = repoContext.repo_connected
    ? repoContext
    : {
        summary: `Knowledge context for ${task.key}`,
        repo_connected: false,
        relevant_modules: ["src/components", "src/api", "src/hooks"],
        constraints: ["Set TARGET_REPO_PATH in .env to connect a local codebase"],
        dependencies: [],
        risks: [],
        documentation_refs: [],
        codebase_notes: "No local repo connected",
      };

  const user = `Jira Task:
Key: ${task.key}
Summary: ${task.summary}
Description: ${task.description || "(none)"}
Type: ${task.issue_type || "Task"}
Priority: ${task.priority || "Medium"}

Use the local codebase scan below. If repo_connected is true, base relevant_modules and risks on real paths.

Local codebase scan:
${JSON.stringify(repoContext, null, 2)}`;

  const knowledge = await chatJson(SYSTEM, user, mockPayload);

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
        output_summary: knowledge.summary,
      },
    ],
  };
}
