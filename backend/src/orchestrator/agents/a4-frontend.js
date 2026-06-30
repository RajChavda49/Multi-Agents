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
import { config } from "../../config.js";
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
import {
  checkDeliverablesCoverage,
  formatDeliverablesForPrompt,
} from "../task-deliverables.js";

const SYSTEM = `You are A4 — autonomous staff frontend engineer (Next.js/React).

Read the FULL Jira ticket, task_deliverables, and coding_strategy. You decide how to implement.

OUTPUT (JSON only — no markdown, no prose):
{"edits":[{"path":"...","search":"...","replace":"..."}],"files":[{"path":"...","content":"..."}]}

DECISION RULES:
1. NEW feature → "files" with full components; patch page/layout only to import them
2. Copy tweak in one file → single-line "edits" from verbatim_anchors
3. skip_patch_paths → do not edit; create new files instead
4. Never put EXISTING paths in "files" unless creating a new path
5. Full runnable code — no stubs
6. Keep JSON compact — minimal comments`;

const SYSTEM_ONE_DELIVERABLE = `${SYSTEM}

FOCUS MODE: Implement ONLY the single deliverable named in the prompt. One files[] entry minimum.`;

function shouldUseSequentialA4(state, deliverables, createFirst) {
  if (deliverables.length <= 1) return false;
  if (createFirst) return true;
  if ((state.agent_attempt || 1) >= 2) return true;
  if (/invalid JSON|truncated|incomplete: missing deliverable/i.test(state.agent_last_error || "")) {
    return true;
  }
  return false;
}

function buildA4Context(state) {
  const spec = state.technical_spec;
  const task = state.jira_task;
  const knowledge = { ...state.knowledge_context, jira_task: task };
  const escalation = state.escalation_level || 0;

  const previewPayload = formatSpecForCoding(spec, knowledge, { includeContent: false });
  const strategy = resolveA4WriteStrategy(knowledge, previewPayload, state);
  const createFirst = strategy.mode === "create";

  const payloadForPrompt = formatSpecForCoding(spec, knowledge, {
    includeContent: !createFirst && strategy.existing.length > 0,
    maxFiles: createFirst ? 0 : Math.min(strategy.existing.length, 2),
    fullFilePaths:
      escalation >= 1 && !createFirst
        ? [...new Set([...strategy.existing, ...Object.keys(state.failed_patch_paths || {})])]
        : [],
  });

  payloadForPrompt.coding_strategy = {
    mode: strategy.mode,
    existing_paths: strategy.existing,
    new_paths: strategy.newPaths,
    suggested_new_file_paths: knowledge.suggested_new_file_paths || strategy.newPaths,
    task_deliverables: knowledge.task_deliverables || strategy.task_deliverables || [],
    skip_patch_paths: strategy.skipPatchPaths || [],
    escalation_level: escalation,
    engineer_directive:
      strategy.engineerDirective ||
      strategy.alternateApproach ||
      (createFirst
        ? "Create new files — one per deliverable."
        : "Patch only listed existing_paths with single-line edits."),
  };

  if (knowledge.task_deliverables?.length) {
    payloadForPrompt.deliverables_checklist = formatDeliverablesForPrompt(knowledge.task_deliverables);
  }

  if (escalation >= 1 && !createFirst) {
    const numberedPaths = [
      ...new Set([
        ...Object.keys(state.failed_patch_paths || {}),
        ...strategy.existing,
      ]),
    ].filter((p) => !strategy.skipPatchPaths?.includes(p));

    payloadForPrompt.numbered_source_files = buildEscalatedFileContext(numberedPaths);
  }

  const jira = formatJiraContextCompact(task);
  const searchPhrases = [
    ...(knowledge?.task_intent?.content_search_phrases || []),
    ...quotedPhrasesFromTask(task),
  ];

  const pathHints = [
    ...(payloadForPrompt.files_to_change || []),
    ...(knowledge?.suggested_new_file_paths || []),
    ...strategy.existing,
    ...strategy.newPaths,
  ];

  return {
    spec,
    task,
    knowledge,
    strategy,
    createFirst,
    payloadForPrompt,
    jira,
    searchPhrases,
    pathHints,
    escalation,
    skipSet: new Set(strategy.skipPatchPaths || []),
    deliverables: knowledge.task_deliverables || [],
  };
}

function processA4Raw(raw, ctx) {
  const { createFirst, pathHints, searchPhrases, skipSet, escalation } = ctx;
  const outputFiles = [];
  let editCount = 0;

  if (!createFirst && Array.isArray(raw?.edits) && raw.edits.length > 0) {
    const allowedEdits = raw.edits.filter((e) => {
      const p = normalizeRelPath(e.path);
      return p && !skipSet.has(p);
    });

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

      if (fileExistsInRepo(relPath) && !skipSet.has(relPath)) {
        if (config.autonomousMode && escalation >= 1) {
          continue;
        }
        throw new Error(
          `A4 put existing file "${relPath}" in "files" — use "edits" or skip this path.`,
        );
      }

      validateNewFileContent(relPath, f.content);
      outputFiles.push({ path: relPath, content: f.content, write_mode: "create" });
    }
  }

  return { outputFiles, editCount, edits: raw?.edits || [] };
}

async function callA4Llm(state, ctx, { focusDeliverable = null, alreadyCreated = [] } = {}) {
  const focusBlock = focusDeliverable
    ? `\n=== FOCUS (this call ONLY) ===\n${formatDeliverablesForPrompt([focusDeliverable])}\nImplement ONLY this deliverable. Return one files[] entry.`
    : "";
  const createdBlock =
    alreadyCreated.length > 0
      ? `\n=== ALREADY CREATED (do not repeat) ===\n${alreadyCreated.map((f) => f.path).join("\n")}`
      : "";

  const user = `${getRetryPromptContext(state)}${ctx.jira.text}
${focusBlock}${createdBlock}

=== SPEC + STRATEGY ===
${JSON.stringify(ctx.payloadForPrompt, null, 2)}

Implement autonomously per coding_strategy.engineer_directive.`;

  return chatJsonCoding(focusDeliverable ? SYSTEM_ONE_DELIVERABLE : SYSTEM, user, {
    agent: "A4",
    pipeline_id: state.pipeline_id,
    images: ctx.jira.images,
    coding: true,
  });
}

async function runA4FrontendOnce(state) {
  const startedAt = new Date().toISOString();
  const ctx = buildA4Context(state);
  const { createFirst, deliverables, escalation } = ctx;

  const sequential = shouldUseSequentialA4(state, deliverables, createFirst);
  const allOutputFiles = [];
  let totalEditCount = 0;
  let allEdits = [];

  if (sequential) {
    const created = [];
    for (const deliverable of deliverables) {
      const raw = await callA4Llm(state, ctx, {
        focusDeliverable: deliverable,
        alreadyCreated: created,
      });
      const { outputFiles, editCount, edits } = processA4Raw(raw, ctx);
      if (!outputFiles.length) {
        throw new Error(
          `A4 produced no output for deliverable "${deliverable.label}". Return a files[] entry.`,
        );
      }
      allOutputFiles.push(...outputFiles);
      created.push(...outputFiles);
      totalEditCount += editCount;
      allEdits.push(...edits);
    }
  } else {
    const raw = await callA4Llm(state, ctx);
    const result = processA4Raw(raw, ctx);
    allOutputFiles.push(...result.outputFiles);
    totalEditCount = result.editCount;
    allEdits = result.edits;
  }

  const outputFiles = [
    ...new Map(allOutputFiles.map((f) => [f.path, f])).values(),
  ];

  if (!outputFiles.length) {
    const targets = ctx.strategy.newPaths.length
      ? ctx.strategy.newPaths.join(", ")
      : (ctx.knowledge.suggested_new_file_paths || []).join(", ");
    throw new Error(
      `A4 produced no output. ${targets ? `Create: ${targets}` : "Return files[] and/or edits[]"}`,
    );
  }

  if (deliverables.length > 0) {
    const coverage = checkDeliverablesCoverage(deliverables, outputFiles);
    if (!coverage.complete) {
      const missing = coverage.missing.map((d) => d.label).join(", ");
      throw new Error(
        `A4 incomplete: missing deliverable(s): ${missing}. Add a "files" entry for each — do not stop after the first component.`,
      );
    }
  }

  const mode =
    totalEditCount > 0 && outputFiles.some((f) => f.write_mode === "create")
      ? "hybrid"
      : totalEditCount > 0
        ? "patch"
        : "create";

  return {
    frontend_code: {
      files: outputFiles,
      edits: allEdits,
      mode,
      sequential: sequential || undefined,
    },
    agent_logs: [
      {
        agent: "A4",
        name: "Frontend Coding Agent",
        status: "completed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_summary: `${totalEditCount} patch(es), ${outputFiles.length} file(s) · ${mode}${sequential ? " · per-deliverable" : ""} · esc ${escalation}`,
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
