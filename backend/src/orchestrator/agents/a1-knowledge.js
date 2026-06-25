import { chatJsonPlanning } from "../llm.js";
import { gatherKnowledgeContext } from "../../integrations/local-repo.js";
import { inferTaskSearchIntent } from "../../integrations/repo-task-intent.js";
import { enrichKnowledgeContext } from "../../integrations/edit-targets.js";
import { getRetryPromptContext } from "../retry-context.js";
import { reportAgentActivity } from "../../services/pipeline-progress.js";
import { formatJiraBlock, formatRepoScanForLlm } from "../prompt-format.js";

const SYSTEM = `You are A1 Knowledge Agent for an SDLC pipeline.

Read the Jira task and repo scan. The scan already used an intent pass — trust content/intent-matched files over generic keyword hits.

Respond ONLY with valid JSON:
{
  "summary": "one paragraph: what to do and where",
  "change_scope": "short|medium|long",
  "change_type": "ui_copy|ui_component|styling|api|data_model|full_feature|bugfix|other",
  "backend_needed": false,
  "backend_reason": "why backend is or is not needed",
  "relevant_modules": ["folder paths only, e.g. components/Common/NewHeader"],
  "constraints": ["implementation constraints"],
  "dependencies": ["libs or systems touched"],
  "risks": ["risks"],
  "documentation_refs": ["existing file paths to edit — from scan, not invented"],
  "codebase_notes": "actionable notes for developers"
}

Rules:
- change_scope "short": text/copy swap, single file, config tweak, < ~30 lines
- change_scope "medium": few files, one component flow
- change_scope "long": new feature, many files, API + UI
- backend_needed: true only if task requires API routes, server logic, DB, or auth — not for pure UI/footer/header text
- "header" in Jira means site header/nav — not cart header, skeleton, or table header unless explicitly stated
- relevant_modules: directories only, never individual .js file paths
- documentation_refs: pick from Likely files to edit in the scan when possible`;

function normalizeModuleDirs(modules = []) {
  return [...new Set(modules)]
    .filter((m) => typeof m === "string" && m.length > 0)
    .map((m) => (m.endsWith("/") ? m.slice(0, -1) : m))
    .filter((m) => !/\.(js|jsx|ts|tsx|vue|css|scss)$/i.test(m))
    .slice(0, 12);
}

export async function runA1Knowledge(state) {
  const task = state.jira_task;
  const startedAt = new Date().toISOString();
  reportAgentActivity(state.pipeline_id, {
    status: "phase_1_running",
    phase: "planning",
    current_agent: "A1",
  });

  const taskIntent = await inferTaskSearchIntent(task, state.retry_feedback, state.pipeline_id);
  const repoContext = gatherKnowledgeContext(task, state.retry_feedback, taskIntent);

  const user = `${getRetryPromptContext(state)}${formatJiraBlock(task)}

${formatRepoScanForLlm(repoContext)}

Analyze the task from title + description first, then confirm edit targets from the scan.`;

  const knowledge = await chatJsonPlanning(SYSTEM, user, {
    agent: "A1",
    pipeline_id: state.pipeline_id,
    num_predict: 640,
    num_ctx: 4096,
  });

  const mergedModules = normalizeModuleDirs([
    ...(repoContext.relevant_modules || []),
    ...(knowledge.relevant_modules || []),
    ...(taskIntent.relevant_module_hints || []),
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
      repo_connected: repoContext.repo_connected,
      task_intent: taskIntent,
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
        output_summary: `${knowledge.change_scope || "?"} scope · backend ${knowledge.backend_needed ? "yes" : "no"} — ${(knowledge.summary || "").slice(0, 80)}`,
      },
    ],
  };
}
