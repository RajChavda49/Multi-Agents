import { fileExistsInRepo, normalizeRelPath, readRepoFile } from "../integrations/edit-targets.js";
import { addLineNumbers } from "../integrations/patch-context.js";
import { config } from "../config.js";
import {
  isGreenfieldTask,
  isPatchPreferredTask,
  suggestNewFilePaths,
} from "./task-paths.js";
import {
  formatDeliverablesForPrompt,
  parseTaskDeliverables,
} from "./task-deliverables.js";

export function isTestFilePath(relPath) {
  const p = normalizeRelPath(relPath);
  return (
    /(^|\/)(__tests__|tests?|e2e|cypress|playwright)(\/|$)/i.test(p) ||
    /\.(test|spec)\.(js|jsx|ts|tsx)$/i.test(p)
  );
}

export function listCodingTargetPaths(knowledge, specPayload = {}) {
  const paths = new Set();
  for (const p of specPayload.files_to_change || []) {
    if (p) paths.add(normalizeRelPath(p));
  }
  for (const t of knowledge?.edit_targets || []) {
    if (t?.path && t.exists !== false) paths.add(normalizeRelPath(t.path));
  }
  for (const p of knowledge?.user_confirmed_targets || []) {
    if (p) paths.add(normalizeRelPath(p));
  }
  for (const p of knowledge?.suggested_new_file_paths || []) {
    if (p) paths.add(normalizeRelPath(p));
  }
  return [...paths].filter(Boolean);
}

export function partitionPathsByExistence(paths) {
  const existing = [];
  const newPaths = [];
  for (const p of paths) {
    if (fileExistsInRepo(p)) existing.push(p);
    else newPaths.push(p);
  }
  return { existing, newPaths };
}

/** Drop unrelated targets — never drop an area the ticket explicitly requests. */
export function filterPatchTargetsByTask(paths, jiraTask, knowledge = {}) {
  const parsed =
    knowledge?.task_deliverables?.length > 0
      ? {
          wantsFooter: knowledge.task_deliverables.some((d) => d.id === "footer"),
          wantsHeader: knowledge.task_deliverables.some((d) => d.id === "header"),
        }
      : parseTaskDeliverables(jiraTask);

  const { wantsFooter, wantsHeader } = parsed;
  const text = `${jiraTask?.summary || ""} ${jiraTask?.description || ""}`.toLowerCase();
  const isHomepage =
    /\b(home\s*page|homepage|landing|hero|ecommerce home)\b/.test(text) ||
    jiraTask?.change_type === "full_feature";

  return paths.filter((p) => {
    const lower = p.toLowerCase();
    if (lower.includes("footer") && !wantsFooter && isHomepage) return false;
    if (lower.includes("global-footer") && !wantsFooter) return false;
    if (lower.includes("global-header") && !wantsHeader && isHomepage) return false;
    if (lower.includes("cart") && isHomepage && !text.includes("cart")) return false;
    return true;
  });
}

export function resolveA4WriteStrategy(knowledge, specPayload, state = {}) {
  const jiraTask = knowledge?.jira_task || state.jira_task;
  const escalation = state.escalation_level || 0;
  const skipPaths = new Set([
    ...Object.keys(state.failed_patch_paths || {}),
    ...(state.skip_patch_paths || []),
  ]);

  let allPaths = listCodingTargetPaths(knowledge, specPayload);
  if (jiraTask) {
    allPaths = filterPatchTargetsByTask(allPaths, jiraTask, knowledge);
  }

  const { existing, newPaths } = partitionPathsByExistence(allPaths);
  const patchable = existing.filter((p) => !skipPaths.has(p));
  const suggested = suggestNewFilePaths(knowledge, jiraTask);
  const mergedNewPaths = [...new Set([...newPaths, ...suggested])].slice(0, 12);
  const allowNew =
    knowledge?.allow_new_files === true || (config.autonomousMode && isGreenfieldTask(knowledge, jiraTask));
  const patchPreferred = isPatchPreferredTask(knowledge, jiraTask);
  const greenfield = isGreenfieldTask(knowledge, jiraTask);
  const deliverables = knowledge?.task_deliverables || parseTaskDeliverables(jiraTask).deliverables;
  const deliverableDirective = deliverables.length
    ? `Implement ALL deliverables (each needs file(s)):\n${formatDeliverablesForPrompt(deliverables)}`
    : "Read Jira and implement every UI area mentioned.";

  if (allowNew && (greenfield || deliverables.length > 1) && !patchPreferred && escalation < 1) {
    const wirePaths = patchable.filter((p) => /pages\/|app\/.*page/i.test(p)).slice(0, 1);
    return {
      mode: wirePaths.length ? "hybrid" : "create",
      existing: wirePaths,
      newPaths: mergedNewPaths,
      allowNewFiles: true,
      escalation,
      skipPatchPaths: [...skipPaths],
      engineerDirective: `${deliverableDirective}\nCreate NEW component files per deliverable. Wire them in layout/page. Do not stop after the first component.`,
      task_deliverables: deliverables,
    };
  }

  if (escalation >= 1 || (escalation >= 2 && patchable.length === 0)) {
    return {
      mode: "create",
      existing: [],
      newPaths: mergedNewPaths,
      allowNewFiles: allowNew,
      escalation,
      skipPatchPaths: [...skipPaths, ...patchable],
      alternateApproach: `${deliverableDirective}\nPatching failed — create NEW files for each deliverable.`,
      task_deliverables: deliverables,
    };
  }

  if (patchable.length > 0) {
    return {
      mode: mergedNewPaths.length && allowNew ? "hybrid" : "patch",
      existing: patchable.slice(0, 2),
      newPaths: allowNew ? mergedNewPaths : [],
      allowNewFiles: allowNew,
      escalation,
      skipPatchPaths: [...skipPaths],
    };
  }

  if (allowNew) {
    return { mode: "create", existing: [], newPaths: mergedNewPaths, allowNewFiles: true, escalation };
  }

  return { mode: "patch", existing: patchable, newPaths: [], allowNewFiles: false, escalation };
}

export function buildEscalatedFileContext(paths, options = {}) {
  const maxChars = options.maxChars ?? (Number(process.env.OLLAMA_CODING_MAX_EXCERPT_CHARS) || 6000);
  return paths
    .map((relPath) => {
      const raw = readRepoFile(relPath, 0);
      if (!raw) return null;
      let numbered = addLineNumbers(raw);
      if (numbered.length > maxChars) {
        numbered = numbered.slice(0, maxChars) + "\n/* …truncated … */";
      }
      return {
        path: relPath,
        numbered_source: numbered,
        line_count: raw.split("\n").length,
        instruction:
          'Copy ONE complete line from numbered_source as "search" (exact characters).',
      };
    })
    .filter(Boolean);
}

export function validateNewFileContent(relPath, content) {
  const len = (content || "").length;
  const minLen = isTestFilePath(relPath) ? 40 : 80;
  if (len < minLen) {
    throw new Error(
      `Refusing stub content for ${relPath} (${len} chars). Write a complete, production-ready file — not placeholders.`,
    );
  }
  if (/^\/\/\s*\w+|placeholder|TODO:\s*implement/i.test((content || "").trim())) {
    if (len < 200) {
      throw new Error(
        `Refusing placeholder content for ${relPath}. Implement the full component with imports, logic, and export.`,
      );
    }
  }
}
