import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { runPlanningPhase, resumeGate1, getGraphState } from "../orchestrator/graph.js";
import { getPipeline, savePipeline, listPipelines } from "../storage/pipelines.js";
import {
  isJiraConfigured,
  getIssue,
  extractDescription,
  buildBrowseUrl,
  addComment,
} from "../integrations/jira-client.js";

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
  return listPipelines().some(
    (p) =>
      p.jira_task?.key?.toUpperCase() === jiraKey.toUpperCase() &&
      !["gate_1_rejected", "failed", "completed"].includes(p.status),
  );
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
    error: null,
    agent_logs: [],
    created_at: now,
    updated_at: now,
  };

  savePipeline(initial);

  try {
    const result = await runPlanningPhase({ ...initial, pipeline_id: id });
    const merged = { ...initial, ...result, id, pipeline_id: id };
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

  if (pipelineExistsForJiraKey(key)) {
    throw new Error(`An active pipeline already exists for ${key}`);
  }

  return createAndRunPipeline({ jira_key: key, fetch_from_jira: true });
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
  const graphState = (await getGraphState(pipelineId)) || {};
  const merged = {
    ...existing,
    ...graphState,
    ...result,
    id: pipelineId,
    pipeline_id: pipelineId,
    status: result.gate_1_approved ? "gate_1_approved" : "gate_1_rejected",
    agent_logs: [
      ...(existing.agent_logs || []),
      ...((result.agent_logs || graphState.agent_logs || []).filter(
        (log) =>
          !(existing.agent_logs || []).some(
            (e) => e.agent === log.agent && e.completed_at === log.completed_at,
          ),
      )),
    ],
  };
  savePipeline(merged);

  if (isJiraConfigured() && existing.jira_task?.key) {
    try {
      await addComment(
        existing.jira_task.key,
        `SDLC Agents: Gate 1 APPROVED.${feedback ? ` Note: ${feedback}` : ""}`,
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
  const graphState = (await getGraphState(pipelineId)) || {};
  const merged = {
    ...existing,
    ...graphState,
    ...result,
    id: pipelineId,
    pipeline_id: pipelineId,
    status: "gate_1_rejected",
    gate_1_feedback: feedback,
    agent_logs: [...(existing.agent_logs || []), ...(result.agent_logs || [])],
  };
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

export { CreatePipelineSchema, GateDecisionSchema };
