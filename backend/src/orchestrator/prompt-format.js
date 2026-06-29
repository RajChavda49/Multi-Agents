/** Shared Jira + repo formatting for LLM prompts (all agents use LLM). */

import { formatEditTargetsForPrompt } from "../integrations/edit-targets.js";
import { imagePartsForLlm } from "../integrations/jira-images.js";

function formatJiraImagesBlock(images = []) {
  if (!images.length) return "";

  const lines = images.map((img, index) => {
    const parts = [`Image ${index + 1}: ${img.filename}`];
    if (img.alt_text) parts.push(`alt="${img.alt_text}"`);
    if (img.description) parts.push(`→ ${img.description}`);
    else parts.push("→ (visual reference attached for vision models)");
    if (img.url) parts.push(`file: ${img.url}`);
    return parts.join(" ");
  });

  return `=== JIRA DESCRIPTION IMAGES (${images.length}) ===\n${lines.join("\n")}`;
}

export function formatJiraImagesCompact(images = []) {
  if (!images.length) return "";
  const summaries = images
    .map((img) => img.description || img.filename)
    .filter(Boolean)
    .slice(0, 3);
  return summaries.length ? `Images: ${summaries.join(" | ")}` : "";
}

export function formatJiraContext(task) {
  return {
    text: formatJiraBlock(task),
    images: imagePartsForLlm(task.description_images),
  };
}

export function formatJiraContextCompact(task) {
  const base = formatJiraBlockCompact(task);
  const img = formatJiraImagesCompact(task.description_images);
  return {
    text: img ? `${base}\n${img}` : base,
    images: imagePartsForLlm(task.description_images),
  };
}

export function formatJiraTask(task) {
  const desc = (task.description || "").trim();
  const ac = extractAcceptanceCriteria(desc);
  return {
    key: task.key,
    summary: task.summary,
    description: desc.slice(0, 2000),
    acceptance_criteria: ac,
    type: task.issue_type || "Task",
    priority: task.priority || "Medium",
  };
}

export function formatJiraBlock(task) {
  const t = formatJiraTask(task);
  let block = `=== JIRA ${t.key} ===
Summary: ${t.summary}
Type: ${t.type} | Priority: ${t.priority}

Description:
${t.description || "(none)"}`;

  if (t.acceptance_criteria.length) {
    block += `\n\nAcceptance criteria:\n${t.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`;
  }

  const imgBlock = formatJiraImagesBlock(task.description_images);
  if (imgBlock) block += `\n\n${imgBlock}`;

  return block;
}

function extractAcceptanceCriteria(description) {
  if (!description) return [];
  const checked = [...description.matchAll(/\[ \]\s*(.+)/g)].map((m) => m[1].trim());
  if (checked.length) return checked;
  const bullets = [...description.matchAll(/^[-*]\s*(.+)/gm)].map((m) => m[1].trim());
  return bullets.slice(0, 10);
}

/** Best files first: content matches, then intent, then keyword — with short snippets. */
export function formatRepoScanForLlm(repoContext) {
  if (!repoContext?.repo_connected) {
    return "=== REPO ===\nNot connected — plan from Jira description only.";
  }

  const intent = repoContext.task_intent;
  const order = { content: 0, intent: 1, keyword: 2 };
  const ordered = [...(repoContext.matched_files || [])]
    .sort((a, b) => (order[a.match_type] ?? 3) - (order[b.match_type] ?? 3))
    .slice(0, 6);

  const files = ordered.map((f) => ({
    path: f.path,
    match: f.match_type || "keyword",
    snippet: (f.snippet || "").slice(0, 220).replace(/\s+/g, " ").trim(),
  }));

  let block = `=== REPO SCAN ===
Project: ${repoContext.project_name || "unknown"} | Stack: ${(repoContext.stack || []).join(", ")}
Path: ${repoContext.repo_path}`;

  if (intent?.intent_summary) {
    block += `

Task intent (read ticket first):
${intent.intent_summary}
UI area: ${intent.ui_area || "unknown"}`;
  }

  block += `

Likely files to edit:
${files.length ? JSON.stringify(files, null, 2) : "(no matches — infer from description)"}

Relevant module folders: ${JSON.stringify((repoContext.relevant_modules || []).slice(0, 6))}

Notes: ${(repoContext.codebase_notes || "").slice(0, 300)}`;

  return block;
}

export function formatJiraBlockCompact(task) {
  const t = formatJiraTask(task);
  const ac = t.acceptance_criteria.slice(0, 3);
  let block = `${t.key}: ${t.summary}`;
  if (ac.length) block += `\nAccept: ${ac.join(" | ")}`;
  const quoted = [...(t.description || "").matchAll(/"([^"]{3,80})"/g)].map((m) => m[1]);
  if (quoted.length) block += `\nCopy: ${quoted.map((q) => `"${q}"`).join(", ")}`;
  const img = formatJiraImagesCompact(task.description_images);
  if (img) block += `\n${img}`;
  return block;
}

export function formatKnowledgeForA2(knowledge) {
  const editBlock = formatEditTargetsForPrompt(knowledge, { includeContent: false, maxFiles: 4 });
  return {
    summary: knowledge.summary,
    change_scope: knowledge.change_scope,
    change_type: knowledge.change_type,
    backend_needed: knowledge.backend_needed,
    backend_reason: knowledge.backend_reason,
    stack: knowledge.stack,
    target_confidence: knowledge.target_confidence,
    files_to_edit: editBlock.files_to_change,
    allow_new_files: knowledge.allow_new_files === true,
    edit_rule: editBlock.rule,
    target_files: (knowledge.edit_targets || knowledge.matched_files || [])
      .slice(0, 5)
      .map((f) => ({ path: f.path, exists: f.exists !== false, match: f.match_type || f.source })),
    constraints: (knowledge.constraints || []).slice(0, 4),
    risks: (knowledge.risks || []).slice(0, 3),
  };
}

export function formatSpecForA3(spec) {
  return {
    title: spec.title,
    overview: (spec.overview || "").slice(0, 500),
    change_scope: spec.change_scope,
    backend_needed: spec.backend_needed,
    acceptance_criteria: (spec.acceptance_criteria || []).slice(0, 8),
    frontend_tasks: (spec.frontend_tasks || []).slice(0, 6),
    backend_tasks: (spec.backend_tasks || []).slice(0, 4),
  };
}

export function formatSpecForCoding(spec, knowledge, options = {}) {
  const scope = spec.change_scope || knowledge?.change_scope || "medium";
  const editBlock = formatEditTargetsForPrompt(knowledge, {
    changeScope: scope,
    includeContent: options.includeContent !== false,
    maxFiles: options.maxFiles,
    fullFilePaths: options.fullFilePaths,
  });

  const payload = {
    title: spec.title,
    overview: (spec.overview || "").slice(0, 280),
    change_scope: scope,
    change_type: spec.change_type || knowledge?.change_type,
    acceptance_criteria: (spec.acceptance_criteria || []).slice(0, 4),
    frontend_tasks: (spec.frontend_tasks || []).slice(0, 3),
    files_to_change: editBlock.files_to_change,
    allow_new_files: editBlock.allow_new_files,
    edit_rule: editBlock.rule,
  };

  if (editBlock.existing_files?.length) {
    payload.existing_files = editBlock.existing_files;
  }

  return payload;
}
