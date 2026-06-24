import { chatJsonCoding } from "../llm.js";
import { getRepoPromptContext } from "../../integrations/local-repo.js";
import { getRetryPromptContext } from "../retry-context.js";

const SYSTEM = `You are A5 Backend Coding Agent. Generate backend/API code changes for the connected project from the technical spec.
Match the project's existing API layout and patterns.
Respond ONLY with valid JSON: { "files": [{ "path": "relative/path/from/repo/root", "content": "full source code" }] }`;

export async function runA5Backend(state) {
  const spec = state.technical_spec;
  const task = state.jira_task;
  const startedAt = new Date().toISOString();

  const user = `${getRetryPromptContext(state)}Jira: ${task.key}
${getRepoPromptContext(state.knowledge_context)}

Spec:
${JSON.stringify(spec, null, 2)}

Generate only files required for this task. Prefer editing existing API modules over creating parallel structures.`;

  const result = await chatJsonCoding(SYSTEM, user, { agent: "A5", pipeline_id: state.pipeline_id });

  return {
    backend_code: result,
    agent_logs: [
      {
        agent: "A5",
        name: "Backend Coding Agent",
        status: "completed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_summary: `${(result.files || []).length} backend files generated`,
      },
    ],
  };
}
