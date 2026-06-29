import { chatJsonCoding } from "../llm.js";
import { getRetryPromptContext } from "../retry-context.js";
import {
  formatJiraContextCompact,
  formatSpecForCoding,
} from "../prompt-format.js";
import {
  reportAgentStarted,
  reportAgentCompleted,
  reportAgentFailed,
} from "../../services/pipeline-progress.js";
import { runAgentWithRetry } from "../../services/agent-retry.js";
import {
  applyEditsToRepo,
  fileExistsInRepo,
  normalizeRelPath,
  quotedPhrasesFromTask,
} from "../../integrations/edit-targets.js";
import {
  resolveA4WriteStrategy,
  validateNewFileContent,
  buildEscalatedFileContext,
} from "../coding-strategy.js";

const SYSTEM = `You are A4 — staff-level frontend engineer on Next.js/React.
Read the task, coding_strategy, and source context. Pick the minimum correct change.

═══ OUTPUT ═══
{"edits":[{"path":"...","search":"...","replace":"..."}],"files":[{"path":"...","content":"..."}]}

═══ PATCHING EXISTING FILES ═══
- Use "edits" only — never put existing paths in "files"
- "search" = ONE complete line copied EXACTLY from verbatim_anchors or numbered_source (spaces, quotes, JSX)
- "replace" = that same line with only the required change
- If numbered_source is provided, pick a line number from it — do not paraphrase

═══ NEW FILES ═══
- Use "files" only for paths that do not exist yet
- Full runnable component code — no stubs

═══ WHEN STUCK ═══
- If skip_patch_paths lists a file → do NOT edit it; implement via new components + imports
- Homepage tasks → create components/Homepage/* — don't rewrite global-footer/header unless ticket says so`;

async function runA4FrontendOnce(state) {
  const spec = state.technical_spec;
  const task = state.jira_task;
  const knowledge = { ...state.knowledge_context, jira_task: task };
  const startedAt = new Date().toISOString();
  const escalation = state.escalation_level || 0;

  const previewPayload = formatSpecForCoding(spec, knowledge, { includeContent: false });
  const strategy = resolveA4WriteStrategy(knowledge, previewPayload, state);

  const includeFullFor = [
    ...strategy.existing,
    ...(escalation >= 1 ? Object.keys(state.failed_patch_paths || {}) : []),
  ].filter((p) => !strategy.skipPatchPaths?.includes(p));

  const payloadForPrompt = formatSpecForCoding(spec, knowledge, {
    includeContent: strategy.existing.length > 0,
    maxFiles: Math.max(strategy.existing.length, 2),
    fullFilePaths: escalation >= 1 ? [...new Set(includeFullFor)] : [],
  });

  payloadForPrompt.coding_strategy = {
    mode: strategy.mode,
    existing_paths: strategy.existing,
    new_paths: strategy.newPaths,
    skip_patch_paths: strategy.skipPatchPaths || [],
    escalation_level: escalation,
    rule: strategy.alternateApproach || strategy.existing.length
      ? "existing_paths → single-line edits from numbered_source. new_paths → full files."
      : "Create new files with complete implementations.",
  };

  if (escalation >= 1) {
    const numberedPaths = [
      ...new Set([
        ...Object.keys(state.failed_patch_paths || {}),
        ...strategy.existing,
      ]),
    ].filter((p) => !strategy.skipPatchPaths?.includes(p));

    payloadForPrompt.numbered_source_files = buildEscalatedFileContext(numberedPaths);

    for (const [path, ctx] of Object.entries(state.failed_patch_paths || {})) {
      if (!payloadForPrompt.numbered_source_files?.some((f) => f.path === path) && ctx.numbered_source) {
        payloadForPrompt.numbered_source_files = payloadForPrompt.numbered_source_files || [];
        payloadForPrompt.numbered_source_files.push({
          path,
          numbered_source: ctx.numbered_source,
          instruction: ctx.recovery_hint,
        });
      }
    }
  }

  const jira = formatJiraContextCompact(task);
  const searchPhrases = [
    ...(knowledge?.task_intent?.content_search_phrases || []),
    ...quotedPhrasesFromTask(task),
  ];

  const user = `${getRetryPromptContext(state)}${jira.text}

=== IMPLEMENTATION SPEC ===
${JSON.stringify(payloadForPrompt, null, 2)}

Follow coding_strategy. ${
    escalation >= 2
      ? "Alternate approach required — skip failed paths, use new components."
      : "Copy patch search lines verbatim from numbered_source or verbatim_anchors."
  }`;

  const raw = await chatJsonCoding(SYSTEM, user, {
    agent: "A4",
    pipeline_id: state.pipeline_id,
    images: jira.images,
  });

  const pathHints = [
    ...(payloadForPrompt.files_to_change || []),
    ...(knowledge?.suggested_new_file_paths || []),
    ...strategy.existing,
    ...strategy.newPaths,
  ];

  const outputFiles = [];
  let editCount = 0;
  const skipSet = new Set(strategy.skipPatchPaths || []);

  if (Array.isArray(raw?.edits) && raw.edits.length > 0) {
    const allowedEdits = raw.edits.filter((e) => {
      const p = normalizeRelPath(e.path);
      return p && !skipSet.has(p);
    });

    if (allowedEdits.length < raw.edits.length) {
      console.warn(
        `[A4] Dropped ${raw.edits.length - allowedEdits.length} edit(s) for skip_patch_paths`,
      );
    }

    if (allowedEdits.length > 0) {
      const patched = applyEditsToRepo(allowedEdits, { pathHints, searchPhrases });
      for (const f of patched) {
        outputFiles.push({ ...f, write_mode: "patch_result" });
      }
      editCount = allowedEdits.length;
    }
  }

  if (Array.isArray(raw?.files) && raw.files.length > 0) {
    for (const f of raw.files) {
      const relPath = normalizeRelPath(f.path);
      if (!relPath || !f.content) continue;

      if (fileExistsInRepo(relPath)) {
        throw new Error(
          `A4 put existing file "${relPath}" in "files" — use single-line "edits" from numbered_source instead.`,
        );
      }

      validateNewFileContent(relPath, f.content);
      outputFiles.push({ path: relPath, content: f.content, write_mode: "create" });
    }
  }

  if (!outputFiles.length) {
    if (strategy.allowNewFiles && strategy.newPaths.length) {
      throw new Error(
        `A4 produced no output. Create new files at: ${strategy.newPaths.join(", ")} — patching existing paths is optional/failing.`,
      );
    }
    throw new Error(
      `A4 returned no applicable changes. Got: ${JSON.stringify(raw).slice(0, 300)}`,
    );
  }

  const mode =
    editCount > 0 && outputFiles.some((f) => f.write_mode === "create")
      ? "hybrid"
      : editCount > 0
        ? "patch"
        : "create";

  return {
    frontend_code: { files: outputFiles, edits: raw.edits || [], mode },
    agent_logs: [
      {
        agent: "A4",
        name: "Frontend Coding Agent",
        status: "completed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_summary: `${editCount} patch(es), ${outputFiles.length} file(s) · ${mode} · esc ${escalation}`,
      },
    ],
  };
}

export async function runA4Frontend(state) {
  reportAgentStarted(state.pipeline_id, "A4", {
    status: "phase_2_running",
    phase: "development",
  });

  try {
    const output = await runAgentWithRetry(
      "A4",
      state.pipeline_id,
      (attemptState) => runA4FrontendOnce(attemptState),
      state,
    );
    reportAgentCompleted(state.pipeline_id, "A4", output);
    return output;
  } catch (err) {
    reportAgentFailed(state.pipeline_id, "A4", err);
    throw err;
  }
}
