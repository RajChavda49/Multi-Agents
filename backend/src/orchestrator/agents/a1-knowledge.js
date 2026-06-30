import { chatJsonPlanning } from "../llm.js";
import { gatherKnowledgeContext } from "../../integrations/local-repo.js";
import { fallbackIntent } from "../../integrations/repo-task-intent.js";
import { enrichKnowledgeContext } from "../../integrations/edit-targets.js";
import { getRetryPromptContext } from "../retry-context.js";
import { reportAgentActivity } from "../../services/pipeline-progress.js";
import { formatJiraContext, formatRepoScanForLlm } from "../prompt-format.js";
import { parseTaskDeliverables, formatDeliverablesForPrompt } from "../task-deliverables.js";

const SYSTEM = `You are A1 Knowledge Agent — staff engineer analyzing a Jira ticket before implementation.

Read the FULL description and acceptance criteria. Identify EVERY distinct UI area or feature requested (e.g. header AND footer are TWO deliverables, not one).

Respond ONLY with valid JSON:
{
  "summary": "one paragraph listing ALL parts of the work",
  "change_scope": "short|medium|long",
  "change_type": "ui_copy|ui_component|styling|api|data_model|full_feature|bugfix|other",
  "project_scope": "frontend|backend|fullstack",
  "backend_needed": false,
  "backend_reason": "why backend is or is not needed",
  "relevant_modules": ["folder paths only"],
  "constraints": ["implementation constraints"],
  "dependencies": ["libs or systems touched"],
  "risks": ["risks"],
  "documentation_refs": ["paths from repo scan — not invented"],
  "codebase_notes": "actionable notes",
  "task_intent": {
    "intent_summary": "one sentence goal",
    "ui_areas": ["site_header", "site_footer", "page_content"],
    "content_search_phrases": ["exact strings to find in source"],
    "include_path_hints": ["Header", "Footer"],
    "exclude_path_hints": ["CartHeader", "Skeleton"]
  },
  "deliverable_ids": ["header", "footer", "homepage"]
}

Rules:
- project_scope: frontend = UI only; backend = API/DB only; fullstack = both
- If ticket mentions header AND footer → deliverable_ids must include BOTH
- "header" = site nav bar — NOT cart/table/skeleton header
- backend_needed: true only for API/DB/auth — not pure UI`;

function normalizeProjectScope(knowledge) {
  const scope = knowledge?.project_scope;
  if (scope === "frontend" || scope === "backend" || scope === "fullstack") return scope;
  if (knowledge?.backend_needed) return "fullstack";
  if (knowledge?.change_type === "api" || knowledge?.change_type === "data_model") {
    return "backend";
  }
  return "frontend";
}

function normalizeModuleDirs(modules = []) {
  return [...new Set(modules)]
    .filter((m) => typeof m === "string" && m.length > 0)
    .map((m) => (m.endsWith("/") ? m.slice(0, -1) : m))
    .filter((m) => !/\.(js|jsx|ts|tsx|vue|css|scss)$/i.test(m))
    .slice(0, 12);
}

function mergeTaskIntent(heuristic, fromLlm) {
  const llm = fromLlm || {};
  return {
    ...heuristic,
    intent_summary: llm.intent_summary || heuristic.intent_summary,
    ui_area: llm.ui_areas?.[0] || heuristic.ui_area,
    ui_areas: [...new Set([...(llm.ui_areas || []), heuristic.ui_area].filter(Boolean))],
    content_search_phrases: [
      ...new Set([...(heuristic.content_search_phrases || []), ...(llm.content_search_phrases || [])]),
    ].slice(0, 8),
    include_path_hints: [
      ...new Set([...(heuristic.include_path_hints || []), ...(llm.include_path_hints || [])]),
    ],
    exclude_path_hints: [
      ...new Set([...(heuristic.exclude_path_hints || []), ...(llm.exclude_path_hints || [])]),
    ],
    relevant_module_hints: heuristic.relevant_module_hints || [],
  };
}

export async function runA1Knowledge(state) {
  const task = state.jira_task;
  const startedAt = new Date().toISOString();
  reportAgentActivity(state.pipeline_id, {
    status: "phase_1_running",
    phase: "planning",
    current_agent: "A1",
  });

  const parsedDeliverables = parseTaskDeliverables(task);
  const taskIntent = mergeTaskIntent(fallbackIntent(task), null);
  const repoContext = gatherKnowledgeContext(task, state.retry_feedback, taskIntent);

  const jira = formatJiraContext(task);

  const user = `${getRetryPromptContext(state)}${jira.text}

=== PARSED DELIVERABLES (verify — add any missing from description) ===
${formatDeliverablesForPrompt(parsedDeliverables.deliverables)}

${formatRepoScanForLlm(repoContext)}

Analyze the FULL ticket. If description asks for header AND footer, both must appear in deliverable_ids.`;

  const knowledge = await chatJsonPlanning(SYSTEM, user, {
    agent: "A1",
    pipeline_id: state.pipeline_id,
    images: jira.images,
  });

  const finalIntent = mergeTaskIntent(fallbackIntent(task), knowledge.task_intent);

  let deliverables = [...parsedDeliverables.deliverables];
  for (const id of knowledge.deliverable_ids || []) {
    if (!deliverables.some((d) => d.id === id)) {
      const fromParse = parseTaskDeliverables({
        ...task,
        summary: `${task.summary} ${id}`,
        description: `${task.description || ""} ${id}`,
      });
      deliverables = [...deliverables, ...fromParse.deliverables.filter((d) => d.id === id)];
    }
  }
  deliverables = [...new Map(deliverables.map((d) => [d.id, d])).values()];

  const mergedModules = normalizeModuleDirs([
    ...(repoContext.relevant_modules || []),
    ...(knowledge.relevant_modules || []),
    ...(finalIntent.relevant_module_hints || []),
  ]);

  const docRefs = (knowledge.documentation_refs || []).filter(
    (p) => typeof p === "string" && /\.(js|jsx|ts|tsx|vue)$/i.test(p),
  );
  const scanPaths = new Set((repoContext.matched_files || []).map((f) => f.path));
  const extraRefs = docRefs.filter((p) => !scanPaths.has(p) && !p.startsWith("/"));

  const knowledgeContext = enrichKnowledgeContext(
    {
      ...repoContext,
      ...knowledge,
      project_scope: normalizeProjectScope(knowledge),
      backend_needed: knowledge.backend_needed === true,
      repo_connected: repoContext.repo_connected,
      task_intent: finalIntent,
      task_deliverables: deliverables,
      task_deliverables_summary: deliverables.map((d) => d.label).join(" + ") || parsedDeliverables.summary,
      relevant_modules: mergedModules.length ? mergedModules : repoContext.relevant_modules,
      matched_files: repoContext.matched_files,
      documentation_refs: [...(repoContext.documentation_refs || []), ...extraRefs].slice(0, 8),
    },
    task,
  );

  return {
    knowledge_context: knowledgeContext,
    current_agent: "A1",
    agent_logs: [
      {
        agent: "A1",
        name: "Knowledge Agent",
        status: "completed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_summary: `${knowledge.change_scope || "?"} · ${normalizeProjectScope(knowledge)} · ${deliverables.length} deliverable(s): ${deliverables.map((d) => d.id).join(", ") || "general"}`,
      },
    ],
  };
}
