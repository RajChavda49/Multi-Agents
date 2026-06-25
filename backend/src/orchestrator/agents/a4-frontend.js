import { chatJsonCoding } from "../llm.js";
import { getRetryPromptContext } from "../retry-context.js";
import { formatJiraBlockCompact, formatSpecForCoding } from "../prompt-format.js";
import { reportAgentStarted, reportAgentFinished } from "../../services/pipeline-progress.js";

const SYSTEM = `You are A4 Frontend Coding Agent for a Next.js/React project.

Apply ONLY the changes described in the spec. Match existing code style.

Respond ONLY with valid JSON:
{
  "files": [{ "path": "relative/path/from/repo/root", "content": "complete file content" }]
}

Rules:
- EDIT ONLY paths listed in files_to_change — use existing_files excerpts as context; return the FULL file after editing
- FORBIDDEN: creating src/components/* or new Header/Footer files when existing_files is provided
- change_scope "short": edit the minimum files (often 1), preserve all other code
- Return full file content for each changed file, not diffs
- If allow_new_files is false, returning a path not in files_to_change is an error
- Do not add unrelated features or placeholder comments`;

export async function runA4Frontend(state) {
  const spec = state.technical_spec;
  const task = state.jira_task;
  const knowledge = state.knowledge_context;
  const startedAt = new Date().toISOString();
  reportAgentStarted(state.pipeline_id, "A4", {
    status: "phase_2_running",
    phase: "development",
  });

  try {
    const specPayload = formatSpecForCoding(spec, knowledge, { includeContent: true });
    const user = `${getRetryPromptContext(state)}${formatJiraBlockCompact(task)}

=== IMPLEMENTATION ===
${JSON.stringify(specPayload)}`;

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
  } finally {
    reportAgentFinished(state.pipeline_id, "A4");
  }
}
