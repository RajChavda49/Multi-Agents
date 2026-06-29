import { fileExistsInRepo, normalizeRelPath, readRepoFile } from "../integrations/edit-targets.js";
import { addLineNumbers } from "../integrations/patch-context.js";

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

/** Drop weakly-related targets when the Jira task is clearly about another area. */
export function filterPatchTargetsByTask(paths, jiraTask) {
  const text = `${jiraTask?.summary || ""} ${jiraTask?.description || ""}`.toLowerCase();
  const wantsFooter = /\bfooter\b/.test(text);
  const wantsHeader = /\b(header|nav|navbar)\b/.test(text) && !/\bcart header\b/.test(text);
  const isHomepage =
    /\b(home\s*page|homepage|landing|hero|ecommerce home)\b/.test(text) ||
    jiraTask?.change_type === "full_feature";

  return paths.filter((p) => {
    const lower = p.toLowerCase();
    if (lower.includes("footer") && !wantsFooter && isHomepage) return false;
    if (lower.includes("global-footer") && !wantsFooter) return false;
    if (lower.includes("global-header") && !wantsHeader && isHomepage) return false;
    if (lower.includes("cart") && isHomepage) return false;
    return true;
  });
}

export function resolveA4WriteStrategy(knowledge, specPayload, state = {}) {
  const feedback = `${state.retry_feedback || ""} ${state.agent_last_error || ""}`;
  const escalation = state.escalation_level || 0;
  const skipPaths = new Set([
    ...Object.keys(state.failed_patch_paths || {}),
    ...(state.skip_patch_paths || []),
  ]);

  let allPaths = listCodingTargetPaths(knowledge, specPayload);
  if (knowledge?.jira_task || state.jira_task) {
    allPaths = filterPatchTargetsByTask(allPaths, knowledge?.jira_task || state.jira_task);
  }

  const { existing, newPaths } = partitionPathsByExistence(allPaths);
  const patchable = existing.filter((p) => !skipPaths.has(p));

  if (escalation >= 2 && patchable.length === 0 && knowledge?.allow_new_files) {
    return {
      mode: "create",
      existing: [],
      newPaths,
      allowNewFiles: true,
      escalation,
      skipPatchPaths: [...skipPaths],
      alternateApproach:
        "Patching existing files failed repeatedly. Build NEW components under suggested_modules and wire them in the page layout — do not retry failed paths.",
    };
  }

  if (patchable.length > 0 || escalation < 2) {
    return {
      mode: patchable.length ? "hybrid" : "create",
      existing: patchable,
      newPaths: knowledge?.allow_new_files ? newPaths : [],
      allowNewFiles: knowledge?.allow_new_files === true,
      escalation,
      skipPatchPaths: [...skipPaths],
    };
  }

  if (knowledge?.allow_new_files) {
    return { mode: "create", existing: [], newPaths, allowNewFiles: true, escalation };
  }

  return { mode: "patch", existing: patchable, newPaths: [], allowNewFiles: false, escalation };
}

export function buildEscalatedFileContext(paths, options = {}) {
  const maxChars = options.maxChars ?? 14000;
  return paths
    .map((relPath) => {
      const raw = readRepoFile(relPath, 0);
      if (!raw) return null;
      let numbered = addLineNumbers(raw);
      if (numbered.length > maxChars) {
        numbered = numbered.slice(0, maxChars) + "\n/* …file truncated — use visible line numbers … */";
      }
      return {
        path: relPath,
        numbered_source: numbered,
        line_count: raw.split("\n").length,
        instruction:
          'Pick ONE complete line from numbered_source as "search" (copy from "|" onward, including indentation). Change only that line in "replace".',
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
