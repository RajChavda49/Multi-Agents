/** Shared Jira + repo formatting for LLM prompts (all agents use LLM). */

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
  return block;
}

function extractAcceptanceCriteria(description) {
  if (!description) return [];
  const checked = [...description.matchAll(/\[ \]\s*(.+)/g)].map((m) => m[1].trim());
  if (checked.length) return checked;
  const bullets = [...description.matchAll(/^[-*]\s*(.+)/gm)].map((m) => m[1].trim());
  return bullets.slice(0, 10);
}

/** Best files first: content matches, then keyword matches — with short snippets. */
export function formatRepoScanForLlm(repoContext) {
  if (!repoContext?.repo_connected) {
    return "=== REPO ===\nNot connected — plan from Jira description only.";
  }

  const content = (repoContext.matched_files || []).filter((f) => f.match_type === "content");
  const keyword = (repoContext.matched_files || []).filter((f) => f.match_type !== "content");
  const ordered = [...content, ...keyword].slice(0, 6);

  const files = ordered.map((f) => ({
    path: f.path,
    match: f.match_type || "keyword",
    snippet: (f.snippet || "").slice(0, 220).replace(/\s+/g, " ").trim(),
  }));

  return `=== REPO SCAN ===
Project: ${repoContext.project_name || "unknown"} | Stack: ${(repoContext.stack || []).join(", ")}
Path: ${repoContext.repo_path}

Likely files to edit:
${files.length ? JSON.stringify(files, null, 2) : "(no matches — infer from description)"}

Notes: ${(repoContext.codebase_notes || "").slice(0, 300)}`;
}

export function formatKnowledgeForA2(knowledge) {
  return {
    summary: knowledge.summary,
    change_scope: knowledge.change_scope,
    change_type: knowledge.change_type,
    backend_needed: knowledge.backend_needed,
    backend_reason: knowledge.backend_reason,
    stack: knowledge.stack,
    target_files: (knowledge.matched_files || [])
      .slice(0, 5)
      .map((f) => ({ path: f.path, match: f.match_type || "keyword" })),
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

export function formatSpecForCoding(spec, knowledge) {
  return {
    title: spec.title,
    overview: (spec.overview || "").slice(0, 600),
    change_scope: spec.change_scope || knowledge?.change_scope,
    change_type: spec.change_type || knowledge?.change_type,
    backend_needed: spec.backend_needed ?? knowledge?.backend_needed,
    acceptance_criteria: (spec.acceptance_criteria || []).slice(0, 6),
    frontend_tasks: (spec.frontend_tasks || []).slice(0, 5),
    files_to_change: (knowledge?.matched_files || [])
      .filter((f) => f.match_type === "content")
      .slice(0, 4)
      .map((f) => f.path),
  };
}
