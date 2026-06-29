import { chatJsonPlanning } from "../orchestrator/llm.js";
import { formatJiraContext } from "../orchestrator/prompt-format.js";
import { getRetryPromptContext } from "../orchestrator/retry-context.js";

const SYSTEM = `You are a task interpreter for a software repo search step.

Read the Jira title and description carefully. Summarize what the user actually wants in plain language before any code is searched.

Respond ONLY with valid JSON:
{
  "intent_summary": "one sentence: real goal, not just keywords from the title",
  "ui_area": "site_header|site_footer|navigation|page_content|cart|checkout|api|config|styling|other",
  "content_search_phrases": ["exact strings that should appear in source files to find edit targets"],
  "include_path_hints": ["path fragments that likely identify the RIGHT files, e.g. NewHeader, FooterLinks"],
  "exclude_path_hints": ["path fragments to avoid, e.g. CartHeader, Skeleton, checkout when task is site header"],
  "relevant_module_hints": ["folder paths like components/Common/NewHeader"]
}

Rules:
- "header" in a task usually means the main site header / navigation bar — NOT cart header, table header, skeleton, or column header unless the task explicitly says cart/checkout/table.
- "footer" means page footer — NOT email footer or unrelated sections.
- content_search_phrases: prefer quoted UI copy from the ticket; add existing text being replaced if mentioned.
- include_path_hints: 2–6 specific fragments; exclude_path_hints: block common false positives for this ui_area.
- If the task is ambiguous, say so in intent_summary but still pick the most likely ui_area.`;

export async function inferTaskSearchIntent(jiraTask, retryFeedback = "", pipelineId = null) {
  const jira = formatJiraContext(jiraTask);
  const user = `${getRetryPromptContext({ retry_feedback: retryFeedback })}${jira.text}

Interpret this ticket for repo search. Do not assume file paths — infer intent from title + description.`;

  try {
    const raw = await chatJsonPlanning(SYSTEM, user, {
      agent: "A1-intent",
      pipeline_id: pipelineId,
      num_predict: 480,
      num_ctx: 3072,
      images: jira.images,
    });
    return normalizeTaskIntent(raw, jiraTask);
  } catch (err) {
    console.warn(`[repo-intent] LLM intent failed: ${err.message}`);
    return fallbackIntent(jiraTask);
  }
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

export function fallbackIntent(jiraTask) {
  const text = `${jiraTask.summary} ${jiraTask.description}`.toLowerCase();
  let ui_area = "other";
  const exclude = ["skeleton", "mock", "test"];
  const include = [];

  let moduleHints = [];

  if (/\bheader\b/.test(text) && !/\bcart\b/.test(text)) {
    ui_area = "site_header";
    include.push("NewHeader", "Header");
    exclude.push("cart", "checkout", "skeleton", "CartHeader");
    moduleHints = ["components/Common/NewHeader", "components/Common/Header"];
  } else if (/\bfooter\b/.test(text)) {
    ui_area = "site_footer";
    include.push("Footer", "FooterLinks", "NewFooter");
    exclude.push("cart", "checkout", "email");
    moduleHints = ["components/Common/FooterLinks", "components/Common/NewFooter"];
  }

  const quoted = [...`${jiraTask.summary} ${jiraTask.description}`.matchAll(/"([^"]{3,80})"|'([^']{3,80})'/g)]
    .map((m) => m[1] || m[2])
    .filter(Boolean);

  return {
    intent_summary: jiraTask.summary,
    ui_area,
    content_search_phrases: quoted,
    include_path_hints: include,
    exclude_path_hints: exclude,
    relevant_module_hints: moduleHints,
  };
}

export function normalizeTaskIntent(intent, jiraTask) {
  const fallback = fallbackIntent(jiraTask);
  const normalized = { ...(intent || {}) };

  normalized.ui_area = normalizeUiArea(intent?.ui_area) || fallback.ui_area;

  const quoted = fallback.content_search_phrases;
  const llmPhrases = (intent?.content_search_phrases || []).filter(
    (p) => typeof p === "string" && p.length >= 3 && p.length <= 80,
  );
  normalized.content_search_phrases = [...new Set([...quoted, ...llmPhrases])].slice(0, 8);

  if (!(intent?.include_path_hints || []).length) {
    normalized.include_path_hints = fallback.include_path_hints;
  }
  if (!(intent?.exclude_path_hints || []).length) {
    normalized.exclude_path_hints = [
      ...(intent?.exclude_path_hints || []),
      ...fallback.exclude_path_hints,
    ];
  }
  if (!(intent?.relevant_module_hints || []).length) {
    normalized.relevant_module_hints = fallback.relevant_module_hints;
  }

  return normalized;
}
