import fs from "fs";
import path from "path";
import { getTargetRepoPath } from "./local-repo.js";
import {
  editAlreadyApplied,
  findVerbatimAnchors,
  resolveSearchBlock,
} from "./patch-resolve.js";

function resolveEditPath(editPath, hintPaths = []) {
  const rel = normalizeRelPath(editPath);
  if (rel && fileExistsInRepo(rel)) return rel;

  const base = path.basename(rel || editPath || "");
  for (const hint of hintPaths || []) {
    const normalized = normalizeRelPath(hint);
    if (normalized && path.basename(normalized) === base && fileExistsInRepo(normalized)) {
      return normalized;
    }
  }

  return rel;
}

export function normalizeUiArea(uiArea) {
  const area = String(uiArea || "").toLowerCase();
  if (["header", "navigation", "navbar", "site_header", "site header"].includes(area)) {
    return "site_header";
  }
  if (["footer", "site_footer", "site footer"].includes(area)) {
    return "site_footer";
  }
  return uiArea || "other";
}

export function normalizeRelPath(filePath) {
  if (!filePath || typeof filePath !== "string") return "";
  let rel = filePath.trim().replace(/\\/g, "/");
  const repo = getTargetRepoPath();
  if (repo && rel.startsWith(repo)) {
    rel = rel.slice(repo.length).replace(/^\//, "");
  }
  return rel.replace(/^\/+/, "");
}

export function fileExistsInRepo(relPath) {
  const repo = getTargetRepoPath();
  const rel = normalizeRelPath(relPath);
  if (!repo || !rel) return false;
  try {
    const full = path.resolve(repo, rel);
    if (!full.startsWith(path.resolve(repo) + path.sep) && full !== path.resolve(repo)) {
      return false;
    }
    return fs.existsSync(full) && fs.statSync(full).isFile();
  } catch {
    return false;
  }
}

export function readRepoFile(relPath, maxChars = 12000) {
  const repo = getTargetRepoPath();
  const rel = normalizeRelPath(relPath);
  if (!repo || !rel || !fileExistsInRepo(rel)) return null;
  try {
    const full = path.resolve(repo, rel);
    const content = fs.readFileSync(full, "utf-8");
    return maxChars > 0 ? content.slice(0, maxChars) : content;
  } catch {
    return null;
  }
}

function quotedPhrasesFromTask(jiraTask) {
  const text = `${jiraTask?.summary || ""} ${jiraTask?.description || ""}`;
  return [...text.matchAll(/"([^"]{3,80})"|'([^']{3,80})'/g)]
    .map((m) => m[1] || m[2])
    .filter(Boolean);
}

function targetRank(target, knowledge) {
  let score = target.exists === false ? 50 : 0;
  const match = (knowledge?.matched_files || []).find((m) => m.path === target.path);
  if (match?.match_type === "content") score -= 12;
  if (match?.match_type === "intent") score -= 10;
  if (/newheader\/newheader\.(js|jsx|tsx)$/i.test(target.path)) score -= 15;
  if (/footerlinks\/footerlinks\.(js|jsx|tsx)$/i.test(target.path)) score -= 15;
  if (/^src\/components\//i.test(target.path)) score += 10;
  if (/styled|skeleton|algolia|test\./i.test(target.path)) score += 8;
  return score;
}

export function codingPromptLimits(changeScope = "medium") {
  if (changeScope === "short") return { maxFiles: 1, maxCharsPerFile: 3200 };
  if (changeScope === "long") return { maxFiles: 2, maxCharsPerFile: 5500 };
  return { maxFiles: 2, maxCharsPerFile: 4200 };
}

/** Slice large source files to the task-relevant region so coding prompts stay small. */
export function excerptFileForCoding(content, relPath = "", maxChars = 3200, options = {}) {
  if (!content) return "";
  if (content.length <= maxChars) return content;

  const lower = content.toLowerCase();
  const pathLower = relPath.toLowerCase();
  const phrases = (options.phrases || []).map((p) => String(p).trim()).filter((p) => p.length >= 3);

  let anchorAt = -1;
  for (const phrase of phrases) {
    const idx = content.indexOf(phrase);
    if (idx >= 0 && (anchorAt < 0 || idx < anchorAt)) anchorAt = idx;
  }

  const anchors = [
    "<header",
    "return (",
    "return <",
    "render()",
    "render:",
    pathLower.includes("footer") ? "<footer" : null,
    pathLower.includes("footer") ? "stayconnectedbox" : null,
    pathLower.includes("footer") ? "copyrightbox" : null,
    pathLower.includes("header") ? "header" : null,
  ].filter(Boolean);

  if (anchorAt < 0) {
    for (const anchor of anchors) {
      const idx = lower.indexOf(anchor);
      if (idx >= 0 && (anchorAt < 0 || idx < anchorAt)) anchorAt = idx;
    }
  }

  const start = anchorAt >= 0 ? Math.max(0, anchorAt - 320) : 0;
  let excerpt = content.slice(start, start + maxChars);
  const omittedBefore = start;
  const omittedAfter = content.length - (start + excerpt.length);

  if (omittedBefore > 0) {
    excerpt = `/* …${omittedBefore} chars omitted above — edit the full file on disk … */\n${excerpt}`;
  }
  if (omittedAfter > 0) {
    excerpt += `\n/* …${omittedAfter} chars omitted below — preserve remaining imports/logic … */`;
  }
  return excerpt;
}

export function formatEditTargetsForPrompt(knowledge, options = {}) {
  const scope = options.changeScope || knowledge?.change_scope || "medium";
  const limits = codingPromptLimits(scope);
  const maxFiles = options.maxFiles ?? limits.maxFiles;
  // Provide a generous excerpt so the model can write exact search strings
  const maxCharsPerFile = options.maxCharsPerFile ?? Math.min(limits.maxCharsPerFile + 2000, 5000);
  const includeContent = options.includeContent !== false;

  const targets = (knowledge?.edit_targets || [])
    .filter((t) => t.exists !== false)
    .sort((a, b) => targetRank(a, knowledge) - targetRank(b, knowledge))
    .slice(0, maxFiles);

  if (!targets.length) {
    return {
      files_to_change: [],
      existing_files: [],
      patch_mode: true,
      rule: "No confirmed existing files — STOP and set needs_clarification instead of inventing paths.",
    };
  }

  const result = {
    files_to_change: targets.map((t) => t.path),
    allow_new_files: knowledge.allow_new_files === true,
    patch_mode: true,
    rule:
      'Return ONLY { "edits": [{"path", "search", "replace"}] }. Copy "search" VERBATIM from verbatim_anchors or the excerpt (full line, including JSX/tags). Change ONLY the minimum needed.',
  };

  const searchPhrases = [
    ...(knowledge?.task_intent?.content_search_phrases || []),
    ...quotedPhrasesFromTask(knowledge?.jira_task),
  ];

  if (includeContent) {
    result.existing_files = targets.map((t) => {
      const raw = t.content || readRepoFile(t.path, 0) || "";
      const anchors = findVerbatimAnchors(raw, searchPhrases);
      const entry = {
        path: t.path,
        excerpt: excerptFileForCoding(raw, t.path, maxCharsPerFile, { phrases: searchPhrases }),
      };
      if (anchors.length) {
        entry.verbatim_anchors = anchors;
      }
      return entry;
    });
  }

  return result;
}

/**
 * Apply a list of search/replace edits to the target repo files.
 * Each edit: { path, search, replace }
 * Returns an array of { path, content } ready for writeCodeFiles.
 */
export function applyEditsToRepo(edits, options = {}) {
  const files = [];
  const seen = new Map();
  const pathHints = options.pathHints || [];

  for (const edit of edits || []) {
    const rel = resolveEditPath(edit.path, pathHints);
    if (!rel) continue;

    const original = seen.has(rel) ? seen.get(rel) : readRepoFile(rel, 0);
    if (original === null) {
      throw new Error(`applyEditsToRepo: file not found in repo: ${rel}`);
    }

    const rawSearch = edit.search ?? "";
    const rawReplace = edit.replace ?? "";

    if (!rawSearch) {
      throw new Error(`applyEditsToRepo: edit for ${rel} is missing "search" string`);
    }

    if (editAlreadyApplied(original, rawSearch, rawReplace)) {
      seen.set(rel, original);
      continue;
    }

    const resolved = resolveSearchBlock(original, rawSearch, rawReplace);
    if (!resolved) {
      throw new Error(
        `applyEditsToRepo: search block not found in ${rel} — copy an exact line from verbatim_anchors or the excerpt`,
      );
    }

    const { search, replace, strategy } = resolved;

    if (original.length > 500 && search.length > original.length * 0.4) {
      throw new Error(
        `applyEditsToRepo: search block for ${rel} is too large (${search.length} chars = ${Math.round((search.length / original.length) * 100)}% of file). ` +
          `Use a smaller, targeted search string of 3–20 lines that uniquely identifies the change location.`,
      );
    }

    const count = original.split(search).length - 1;
    if (count > 1) {
      throw new Error(
        `applyEditsToRepo: search block matches ${count} times in ${rel} — use a more specific search string`,
      );
    }

    const patched = original.replace(search, replace);

    if (original.length > 500 && patched.length < original.length * 0.85) {
      throw new Error(
        `applyEditsToRepo: edit for ${rel} would shrink file from ${original.length} to ${patched.length} chars. ` +
          `The search block is likely too large. Use a targeted 3–20 line search string that captures only the changed section.`,
      );
    }

    if (strategy !== "exact") {
      console.log(`[patch-resolve] ${rel}: ${strategy} (${rawSearch.length} → ${search.length} chars)`);
    }

    seen.set(rel, patched);
  }

  for (const [filePath, content] of seen) {
    files.push({ path: filePath, content });
  }

  return files;
}

export { quotedPhrasesFromTask };

export function resolveEditTargets(knowledge) {
  const targets = [];
  const seen = new Set();

  function add(pathValue, source, matchType = "resolved") {
    const rel = normalizeRelPath(pathValue);
    if (!rel || seen.has(rel)) return;
    if (!/\.(js|jsx|ts|tsx|vue|css|scss)$/i.test(rel)) return;

    const exists = fileExistsInRepo(rel);
    seen.add(rel);
    targets.push({
      path: rel,
      source,
      match_type: matchType,
      exists,
      content: exists ? readRepoFile(rel, 10000) : null,
    });
  }

  for (const match of knowledge?.matched_files || []) {
    if (match?.path) add(match.path, "repo_scan", match.match_type || "intent");
  }

  for (const ref of knowledge?.documentation_refs || []) {
    if (typeof ref === "string") add(ref, "a1_ref", "a1_ref");
  }

  for (const ref of knowledge?.user_confirmed_targets || []) {
    if (typeof ref === "string") add(ref, "user_confirmed", "user");
  }

  return targets.sort((a, b) => targetRank(a, knowledge) - targetRank(b, knowledge));
}

export function assessEditTargetConfidence(knowledge, jiraTask) {
  const editTargets = resolveEditTargets(knowledge);
  const existing = editTargets.filter((t) => t.exists);
  const primary = existing.filter((t) => targetRank(t, knowledge) < 5);
  const strongMatches = (knowledge?.matched_files || []).filter((m) =>
    ["content", "intent"].includes(m.match_type),
  );

  const issues = [];
  const desc = `${jiraTask?.summary || ""} ${jiraTask?.description || ""}`.toLowerCase();
  const impliesExisting =
    /\bexisting\b|\breplace\b|\bupdate\b|\bedit\b|\bcurrent\b/.test(desc) ||
    knowledge?.change_scope === "short";

  if (!knowledge?.repo_connected) {
    return {
      confidence: "none",
      needs_clarification: true,
      edit_targets: editTargets,
      clarification_issues: ["No codebase connected — cannot locate files to edit."],
    };
  }

  if (existing.length === 0) {
    issues.push("No existing repo files were confidently matched for this task.");
    if (impliesExisting) {
      issues.push("The Jira ticket describes editing existing UI — creating new files is likely wrong.");
    }
  } else if (strongMatches.length === 0 && existing.length > 0) {
    issues.push("Matched files are weak — please confirm the correct edit targets.");
  }

  const hallucinated = editTargets.filter((t) => !t.exists && t.source === "a1_ref");
  if (hallucinated.length) {
    issues.push(
      `A1 suggested paths that do not exist in the repo: ${hallucinated.map((t) => t.path).join(", ")}`,
    );
  }

  const needs_clarification =
    primary.length === 0 || (impliesExisting && strongMatches.length === 0 && primary.length === 0);

  let confidence = "high";
  if (primary.length === 0) confidence = "none";
  else if (needs_clarification || primary.length > 3) confidence = "low";

  return {
    confidence,
    needs_clarification: primary.length === 0 || (impliesExisting && primary.length === 0),
    edit_targets: primary.length ? primary : existing.length ? existing.slice(0, 4) : editTargets,
    clarification_issues: issues,
  };
}

export function enrichKnowledgeContext(knowledge, jiraTask) {
  const assessment = assessEditTargetConfidence(knowledge, jiraTask);
  return {
    ...knowledge,
    edit_targets: assessment.edit_targets,
    target_confidence: assessment.confidence,
    needs_target_clarification: assessment.needs_clarification,
    clarification_issues: assessment.clarification_issues,
    allow_new_files: knowledge.allow_new_files === true,
  };
}

export function applyUserTargetConfirmation(knowledge, decision = {}, jiraTask = null) {
  const rawTargets = decision.confirmed_targets || decision.target_files || [];
  const paths = rawTargets
    .flatMap((entry) => (typeof entry === "string" ? entry.split(/\n|,/) : []))
    .map((p) => normalizeRelPath(p.trim()))
    .filter(Boolean);

  const confirmed = [...new Set(paths)].filter((p) => fileExistsInRepo(p));

  return enrichKnowledgeContext(
    {
      ...knowledge,
      user_confirmed_targets: confirmed,
      allow_new_files: decision.allow_new_files === true,
      user_target_notes: decision.notes || decision.feedback || null,
      needs_target_clarification: false,
      target_confidence: confirmed.length ? "high" : knowledge.target_confidence,
    },
    jiraTask,
  );
}
