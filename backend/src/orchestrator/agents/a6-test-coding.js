import { chatJsonCoding } from "../llm.js";
import { getRetryPromptContext } from "../retry-context.js";
import { formatJiraContextCompact, formatSpecForCoding } from "../prompt-format.js";
import { runAgentWithRetry } from "../../services/agent-retry.js";
import { normalizeRelPath } from "../../integrations/edit-targets.js";
import { isTestFilePath, validateNewFileContent } from "../coding-strategy.js";
import {
  reportAgentStarted,
  reportAgentCompleted,
  reportAgentFailed,
} from "../../services/pipeline-progress.js";

const SYSTEM = `You are A6 Test Coding Agent — a senior engineer writing automated tests.

Respond ONLY with valid JSON:
{
  "files": [{ "path": "relative/path", "content": "full test source" }],
  "mapped_cases": ["TC-001"]
}

Rules:
- Write ONLY test files — paths must be under __tests__/, tests/, e2e/, or end with .test.js / .spec.js / .test.tsx
- NEVER write to component/source paths (e.g. components/Foo/Bar.js) — tests import those, they do not replace them
- If backend_needed is false: frontend/visual/e2e tests only — no API test files
- Each file must contain complete runnable test code — no placeholders
- Map each file to case IDs in mapped_cases
- 1–3 focused test files maximum`;

function normalizeTestFiles(files) {
  const out = [];
  for (const f of files || []) {
    const relPath = normalizeRelPath(f.path);
    if (!relPath || !f.content) continue;

    if (!isTestFilePath(relPath)) {
      throw new Error(
        `A6 must not write source files — use a test path (*.test.js, __tests__/, etc.), not: ${relPath}`,
      );
    }

    validateNewFileContent(relPath, f.content);
    out.push({ path: relPath, content: f.content, write_mode: "create" });
  }
  return out;
}

export async function runA6TestCoding(state) {
  const spec = state.technical_spec;
  const testCases = state.test_cases || [];
  const task = state.jira_task;
  const knowledge = state.knowledge_context;
  const startedAt = new Date().toISOString();
  reportAgentStarted(state.pipeline_id, "A6", {
    status: "phase_2_running",
    phase: "development",
  });

  try {
    const output = await runAgentWithRetry(
      "A6",
      state.pipeline_id,
      async (attemptState) => {
        const jira = formatJiraContextCompact(task);

        const user = `${getRetryPromptContext(attemptState)}${jira.text}

=== SPEC ===
${JSON.stringify(formatSpecForCoding(spec, knowledge, { includeContent: false }), null, 2)}

=== TEST CASES ===
${JSON.stringify(testCases.slice(0, 4), null, 2)}

Write test files only — import components under test, never overwrite them.`;

        const result = await chatJsonCoding(SYSTEM, user, {
          agent: "A6",
          pipeline_id: attemptState.pipeline_id,
          images: jira.images,
        });

        const files = normalizeTestFiles(result.files);

        if (!files.length) {
          throw new Error(
            `A6 returned no valid test files. Use paths like __tests__/Homepage.test.js — got: ${JSON.stringify(result).slice(0, 200)}`,
          );
        }

        return {
          test_code: { ...result, files },
          agent_logs: [
            {
              agent: "A6",
              name: "Test Coding Agent",
              status: "completed",
              started_at: startedAt,
              completed_at: new Date().toISOString(),
              output_summary: `${files.length} test file(s)`,
            },
          ],
        };
      },
      state,
    );
    reportAgentCompleted(state.pipeline_id, "A6", output);
    return output;
  } catch (err) {
    reportAgentFailed(state.pipeline_id, "A6", err);
    throw err;
  }
}
