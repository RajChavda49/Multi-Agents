import { chatJsonCoding } from "../llm.js";
import { getRetryPromptContext } from "../retry-context.js";
import {
  formatJiraBlockCompact,
  formatSpecForCoding,
} from "../prompt-format.js";
import {
  reportAgentStarted,
  reportAgentFinished,
} from "../../services/pipeline-progress.js";
import { applyEditsToRepo } from "../../integrations/edit-targets.js";

/** System prompt for patch (search/replace) mode — the ONLY mode A4 uses */
const SYSTEM_PATCH = `You are A4 Frontend Coding Agent for a Next.js/React codebase.
Apply MINIMAL, SURGICAL changes. The file stays 99% the same — only the relevant lines change.

═══ OUTPUT FORMAT (mandatory) ═══
Respond ONLY with valid JSON:
{"edits":[{"path":"relative/path","search":"exact text to find","replace":"new text"}]}

═══ HOW TO WRITE A GOOD EDIT ═══
Pick a SHORT, UNIQUE anchor from the excerpt — 3 to 15 lines maximum.
Include just enough context to make it unique, then change only what the task requires.

✅ CORRECT — small targeted search:
{"edits":[{
  "path":"components/Footer/Footer.js",
  "search":"  <p className=\"copyright\">© 2023</p>",
  "replace":"  <p className=\"copyright\">© 2024</p>"
}]}

❌ WRONG — search block is the whole file (DO NOT DO THIS):
{"edits":[{
  "path":"components/Footer/Footer.js",
  "search":"import React...\\n[hundreds of lines]...export default Footer;",
  "replace":"<small changed version>"
}]}

The WRONG pattern shrinks the file from 20,000 chars to 300 chars and destroys all the code.

═══ RULES ═══
1. "search" must be copied VERBATIM from verbatim_anchors or the excerpt — include the full line (e.g. <h6>{'text'}</h6>), not just the inner quoted string.
2. "search" length: target 3–15 lines. NEVER use more than 30 lines as a search block.
3. Change ONLY lines required by the task. Leave all other code untouched.
4. For additions: find the nearest anchor line and insert before/after it.
5. For removals: include the lines to remove in "search", set "replace" to empty string or the replacement.
6. Multiple small edits for the same file are fine — add multiple objects to the edits array.
7. FORBIDDEN: {"files":[...]} — rejected immediately. Only {"edits":[...]} is accepted.
8. FORBIDDEN: using the full file content or large sections as "search".`;

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
    const specPayload = formatSpecForCoding(spec, knowledge, {
      includeContent: true,
    });

    const user = `${getRetryPromptContext(state)}${formatJiraBlockCompact(task)}

IMPORTANT — READ BEFORE CODING:
- "search" must be 3–15 lines MAXIMUM. Do NOT use the entire file or large sections as search.
- The file after your edit must be nearly the same size as before (only a few lines changed).
- Preserve ALL existing imports, hooks, functions, JSX, and comments outside your change.

=== FILE EXCERPTS & IMPLEMENTATION SPEC ===
${JSON.stringify(specPayload, null, 2)}

OUTPUT: {"edits":[{"path":"...","search":"<3-15 verbatim lines>","replace":"<changed version>"}]}
DO NOT return {"files":[...]}. DO NOT use large search blocks.`;

    const raw = await chatJsonCoding(SYSTEM_PATCH, user, {
      agent: "A4",
      pipeline_id: state.pipeline_id,
    });

    // ── Validate and resolve edits against the real files on disk ──
    if (!Array.isArray(raw?.edits) || raw.edits.length === 0) {
      throw new Error(
        `A4 returned no edits. Model must return {"edits":[{path,search,replace}]}, got: ${JSON.stringify(raw).slice(0, 200)}`,
      );
    }

    const resolvedFiles = applyEditsToRepo(raw.edits, {
      pathHints: specPayload.files_to_change || [],
    });

    return {
      frontend_code: { files: resolvedFiles, edits: raw.edits },
      agent_logs: [
        {
          agent: "A4",
          name: "Frontend Coding Agent",
          status: "completed",
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          output_summary: `${raw.edits.length} patch edit(s) → ${resolvedFiles.length} file(s) · ${spec.change_scope || "?"} scope`,
        },
      ],
    };
  } finally {
    reportAgentFinished(state.pipeline_id, "A4");
  }
}
