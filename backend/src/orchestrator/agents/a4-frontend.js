import { chatJsonCoding } from "../llm.js";
import { getRetryPromptContext } from "../retry-context.js";
import { formatJiraBlock, formatSpecForCoding } from "../prompt-format.js";

const SYSTEM = `You are A4 Frontend Coding Agent for a Next.js/React project.

Apply ONLY the changes described in the spec. Match existing code style.

Respond ONLY with valid JSON:
{
  "files": [{ "path": "relative/path/from/repo/root", "content": "complete file content" }]
}

Rules:
- change_scope "short": edit the minimum files (often 1), preserve all other code
- Use paths from files_to_change or frontend_tasks when provided
- Return full file content for each changed file, not diffs
- Do not add unrelated features or placeholder comments`;

export async function runA4Frontend(state) {
  const spec = state.technical_spec;
  const task = state.jira_task;
  const knowledge = state.knowledge_context;
  const startedAt = new Date().toISOString();

  const user = `${getRetryPromptContext(state)}${formatJiraBlock(task)}

=== IMPLEMENTATION SPEC ===
${JSON.stringify(formatSpecForCoding(spec, knowledge), null, 2)}

Generate only the frontend files that must change.`;

  const result = await chatJsonCoding(SYSTEM, user, { agent: "A4", pipeline_id: state.pipeline_id });

  return {
    frontend_code: result,
    agent_logs: [
      {
        agent: "A4",
        name: "Frontend Coding Agent",
        status: "completed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_summary: `${(result.files || []).length} file(s) · ${spec.change_scope || "?"} scope`,
      },
    ],
  };
}
