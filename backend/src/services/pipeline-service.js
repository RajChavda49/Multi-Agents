import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import {
  runPlanningPhase,
  resumeGate1,
  resumeGate2,
  getGraphState,
  resolveStatus,
} from "../orchestrator/graph.js";
import { getPipeline, savePipeline, listPipelines, getActivePipelineByJiraKey, normalizeStatus, deletePipeline } from "../storage/pipelines.js";
import {
  isJiraConfigured,
  getIssue,
  extractDescription,
  buildBrowseUrl,
  addComment,
} from "../integrations/jira-client.js";
import { isGitLabConfigured, syncGitLabRepository } from "../integrations/gitlab-client.js";
import { publishPipelineChanges } from "../integrations/repo-target.js";
import { removePipelineWorkspace } from "../orchestrator/workspace.js";

const CreatePipelineSchema = z.object({
  jira_key: z.string().min(1),
  summary: z.string().optional(),
  description: z.string().optional().default(""),
  issue_type: z.string().optional().default("Task"),
  priority: z.string().optional().default("Medium"),
  url: z.string().optional(),
  fetch_from_jira: z.boolean().optional().default(false),
});

const GateDecisionSchema = z.object({
  feedback: z.string().optional(),
});

const TERMINAL_STATUSES = [
  "gate_1_rejected",
  "gate_2_rejected",
  "failed",
  "completed",
  "phase_2_complete",
];

async function resolvePipelineInput(input) {
  const parsed = CreatePipelineSchema.parse(input);
  const shouldFetch =
    parsed.fetch_from_jira || (!parsed.summary && isJiraConfigured());

  if (shouldFetch) {
    if (!isJiraConfigured()) {
      throw new Error(
        "Jira is not configured. Provide summary manually or set JIRA_* env vars.",
      );
    }
    const issue = await getIssue(parsed.jira_key);
    return {
      jira_key: issue.jira_key,
      summary: issue.summary,
      description: issue.description,
      issue_type: issue.issue_type,
      priority: issue.priority,
      url: issue.url,
      status: issue.status,
      assignee: issue.assignee,
    };
  }

  if (!parsed.summary) {
    throw new Error("summary is required when not fetching from Jira");
  }

  return {
    jira_key: parsed.jira_key,
    summary: parsed.summary,
    description: parsed.description,
    issue_type: parsed.issue_type,
    priority: parsed.priority,
    url: parsed.url || buildBrowseUrl(parsed.jira_key),
  };
}

function pipelineExistsForJiraKey(jiraKey) {
  return Boolean(getActivePipelineByJiraKey(jiraKey));
}

function mergeAgentLogs(existing, incoming) {
  const base = existing || [];
  const add = incoming || [];
  return [
    ...base,
    ...add.filter(
      (log) =>
        !base.some((e) => e.agent === log.agent && e.completed_at === log.completed_at),
    ),
  ];
}

async function mergeGraphResult(pipelineId, existing, result) {
  const graphState = (await getGraphState(pipelineId)) || {};
  const rawStatus = await resolveStatus(pipelineId, { ...graphState, ...result });
  const status = normalizeStatus(rawStatus, graphState.phase || result.phase || existing.phase);

  const agent_logs =
    graphState.agent_logs?.length > 0
      ? graphState.agent_logs
      : mergeAgentLogs(existing.agent_logs, result.agent_logs || []);

  return {
    ...existing,
    ...graphState,
    ...result,
    id: pipelineId,
    pipeline_id: pipelineId,
    status,
    agent_logs,
  };
}

function emptyPhase2Fields() {
  return {
    frontend_code: null,
    backend_code: null,
    test_code: null,
    workspace_files: [],
    code_review: null,
    test_execution: null,
    execution_report: null,
    gate_2_approved: null,
    gate_2_feedback: null,
  };
}

export async function createAndRunPipeline(input) {
  const resolved = await resolvePipelineInput(input);
  const id = uuidv4();
  const now = new Date().toISOString();

  const jiraTask = {
    key: resolved.jira_key,
    summary: resolved.summary,
    description: resolved.description,
    issue_type: resolved.issue_type,
    priority: resolved.priority,
    status: resolved.status,
    assignee: resolved.assignee,
    url: resolved.url,
  };

  const initial = {
    id,
    pipeline_id: id,
    jira_task: jiraTask,
    phase: "planning",
    status: "pending",
    current_agent: null,
    knowledge_context: null,
    technical_spec: null,
    test_cases: [],
    test_suite_name: null,
    gate_1_approved: null,
    gate_1_feedback: null,
    ...emptyPhase2Fields(),
    error: null,
    agent_logs: [],
    created_at: now,
    updated_at: now,
  };

  savePipeline(initial);

  if (isGitLabConfigured()) {
    try {
      await syncGitLabRepository();
    } catch (err) {
      console.warn(`GitLab sync before planning failed: ${err.message}`);
    }
  }

  try {
    const result = await runPlanningPhase({ ...initial, pipeline_id: id });
    const merged = await mergeGraphResult(id, initial, result);
    savePipeline(merged);

    if (isJiraConfigured()) {
      try {
        await addComment(
          jiraTask.key,
          `SDLC Agents: Phase 1 planning complete. Status: ${merged.status}. Awaiting Gate 1 review.`,
        );
      } catch {
        // non-blocking
      }
    }

    return merged;
  } catch (err) {
    const failed = {
      ...initial,
      status: "failed",
      error: err.message,
      updated_at: new Date().toISOString(),
    };
    savePipeline(failed);
    throw err;
  }
}

export async function createAndRunPipelineFromJiraKey(jiraKey) {
  const key = jiraKey.toUpperCase();
  const existing = getActivePipelineByJiraKey(key);

  if (existing) {
    return { pipeline: { ...existing, status: normalizeStatus(existing.status, existing.phase) }, existing: true };
  }

  const pipeline = await createAndRunPipeline({ jira_key: key, fetch_from_jira: true });
  return { pipeline, existing: false };
}

export async function approveGate1(pipelineId, feedback = null) {
  const existing = getPipeline(pipelineId);
  if (!existing) {
    throw new Error(`Pipeline not found: ${pipelineId}`);
  }
  if (existing.status !== "awaiting_gate_1") {
    throw new Error(`Pipeline is not awaiting Gate 1 (status: ${existing.status})`);
  }

  const result = await resumeGate1(pipelineId, { approved: true, feedback });
  const merged = await mergeGraphResult(pipelineId, existing, result);
  savePipeline(merged);

  if (isJiraConfigured() && existing.jira_task?.key) {
    try {
      const phase2Note =
        merged.status === "awaiting_gate_2"
          ? " Phase 2 coding complete. Awaiting Gate 2 — review generated code & test scripts."
          : merged.status === "phase_2_complete"
            ? " Phase 2 complete (review, tests, report)."
            : "";
      await addComment(
        existing.jira_task.key,
        `SDLC Agents: Gate 1 APPROVED.${feedback ? ` Note: ${feedback}` : ""}${phase2Note}`,
      );
    } catch {
      // non-blocking
    }
  }

  return merged;
}

export async function rejectGate1(pipelineId, feedback = "Rejected by reviewer") {
  const existing = getPipeline(pipelineId);
  if (!existing) {
    throw new Error(`Pipeline not found: ${pipelineId}`);
  }
  if (existing.status !== "awaiting_gate_1") {
    throw new Error(`Pipeline is not awaiting Gate 1 (status: ${existing.status})`);
  }

  const result = await resumeGate1(pipelineId, { approved: false, feedback });
  const merged = await mergeGraphResult(pipelineId, existing, {
    ...result,
    gate_1_feedback: feedback,
  });
  savePipeline(merged);

  if (isJiraConfigured() && existing.jira_task?.key) {
    try {
      await addComment(
        existing.jira_task.key,
        `SDLC Agents: Gate 1 REJECTED. Feedback: ${feedback}`,
      );
    } catch {
      // non-blocking
    }
  }

  return merged;
}

export async function approveGate2(pipelineId, feedback = null) {
  const existing = getPipeline(pipelineId);
  if (!existing) {
    throw new Error(`Pipeline not found: ${pipelineId}`);
  }
  if (existing.status !== "awaiting_gate_2") {
    throw new Error(`Pipeline is not awaiting Gate 2 (status: ${existing.status})`);
  }

  const result = await resumeGate2(pipelineId, { approved: true, feedback });
  const merged = await mergeGraphResult(pipelineId, existing, result);

  let git_publish = null;
  if (merged.status === "phase_2_complete") {
    try {
      git_publish = await publishPipelineChanges(merged);
      merged.git_publish = git_publish;
    } catch (err) {
      merged.git_publish = { error: err.message };
    }
  }

  savePipeline(merged);

  if (isJiraConfigured() && existing.jira_task?.key) {
    try {
      const mrNote = merged.git_publish?.merge_request?.web_url
        ? ` MR: ${merged.git_publish.merge_request.web_url}`
        : "";
      await addComment(
        existing.jira_task.key,
        `SDLC Agents: Gate 2 APPROVED — review & test execution complete.${feedback ? ` Note: ${feedback}` : ""}${mrNote}`,
      );
    } catch {
      // non-blocking
    }
  }

  return merged;
}

export async function rejectGate2(pipelineId, feedback = "Rejected by reviewer") {
  const existing = getPipeline(pipelineId);
  if (!existing) {
    throw new Error(`Pipeline not found: ${pipelineId}`);
  }
  if (existing.status !== "awaiting_gate_2") {
    throw new Error(`Pipeline is not awaiting Gate 2 (status: ${existing.status})`);
  }

  const result = await resumeGate2(pipelineId, { approved: false, feedback });
  const merged = await mergeGraphResult(pipelineId, existing, {
    ...result,
    gate_2_feedback: feedback,
  });
  savePipeline(merged);

  if (isJiraConfigured() && existing.jira_task?.key) {
    try {
      await addComment(
        existing.jira_task.key,
        `SDLC Agents: Gate 2 REJECTED. Feedback: ${feedback}`,
      );
    } catch {
      // non-blocking
    }
  }

  return merged;
}

export async function parseJiraWebhook(body) {
  const issue = body?.issue;
  if (!issue) return null;

  const fields = issue.fields || {};
  const key = issue.key;

  if (isJiraConfigured()) {
    try {
      return await getIssue(key);
    } catch {
      // fall through to webhook payload
    }
  }

  return {
    jira_key: key,
    summary: fields.summary || "Untitled",
    description: extractDescription(fields.description),
    issue_type: fields.issuetype?.name || "Task",
    priority: fields.priority?.name || "Medium",
    status: fields.status?.name,
    url: buildBrowseUrl(key),
  };
}

export function getPipelineByJiraKey(jiraKey) {
  const active = getActivePipelineByJiraKey(jiraKey);
  if (active) {
    return { ...active, status: normalizeStatus(active.status, active.phase) };
  }
  return null;
}

export function removePipelineById(pipelineId) {
  const existing = getPipeline(pipelineId);
  if (!existing) {
    throw new Error(`Pipeline not found: ${pipelineId}`);
  }

  deletePipeline(pipelineId);
  removePipelineWorkspace(pipelineId);

  return { id: pipelineId, deleted: true, jira_key: existing.jira_task?.key };
}

export { CreatePipelineSchema, GateDecisionSchema };
