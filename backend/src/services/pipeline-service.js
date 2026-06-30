import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import {
  runPlanningPhase,
  retryDevelopmentPhase,
  resumeGate1,
  resumeGate2,
  resumeTargetClarify,
  resumeCodeWriteClarify,
  getGraphState,
  resolveStatus,
} from "../orchestrator/graph.js";
import { ensureOllamaReady } from "../orchestrator/llm.js";
import { getPipeline, savePipeline, listPipelines, getActivePipelineByJiraKey, normalizeStatus, deletePipeline } from "../storage/pipelines.js";
import {
  isJiraConfigured,
  getIssue,
  extractDescription,
  buildBrowseUrl,
  addComment,
} from "../integrations/jira-client.js";
import { isRemoteRepoConfigured, syncRemoteRepository } from "../integrations/remote-repo.js";
import { publishPipelineChanges } from "../integrations/repo-target.js";
import { revertPipelineRepoChanges, cleanupRemotePublish } from "../integrations/repo-revert.js";
import { removePipelineWorkspace } from "../orchestrator/workspace.js";
import { buildFailureRecord, failureSummary } from "./pipeline-errors.js";
import { reportAgentActivity } from "./pipeline-progress.js";
import {
  canAutoRetryPipeline,
  preparePipelineForAutoRetry,
  recordAutoRetryExhausted,
  recordAutoRetryScheduled,
  shouldStopAutoRetry,
} from "./pipeline-auto-retry.js";
import {
  beginRun,
  cancelRun,
  endRun,
  isPipelineCancelledError,
} from "./pipeline-run-control.js";

const activeRuns = new Set();

function startPipelineRun(pipelineId) {
  activeRuns.add(pipelineId);
  beginRun(pipelineId);
}

function stopPipelineRun(pipelineId) {
  endRun(pipelineId);
  activeRuns.delete(pipelineId);
}

function savePipelineFailure(pipelineId, base, err) {
  if (!getPipeline(pipelineId)) return;
  const latest = getPipeline(pipelineId) || base;
  const failure = buildFailureRecord(err, latest);
  const failMsg = failureSummary(failure) || err.message;
  savePipeline({
    ...latest,
    status: "failed",
    error: failMsg,
    failure,
    current_agent: failure.agent || latest.current_agent,
    activity_log: [
      ...(latest.activity_log || []),
      {
        at: new Date().toISOString(),
        level: "error",
        agent: failure.agent,
        message: failMsg,
      },
    ].slice(-300),
    updated_at: new Date().toISOString(),
  });
}

async function runWithPipelineAutoRetry(pipelineId, base, phase, runOnce) {
  let current = base;

  while (true) {
    try {
      return await runOnce(current);
    } catch (err) {
      if (isPipelineCancelledError(err)) throw err;
      if (!getPipeline(pipelineId)) throw err;
      if (shouldStopAutoRetry(err)) throw err;

      const latest = getPipeline(pipelineId) || current;
      if (!canAutoRetryPipeline(latest)) {
        recordAutoRetryExhausted(pipelineId, err);
        throw err;
      }

      current = preparePipelineForAutoRetry(latest, err, phase);
      if (phase === "development") {
        current.gate_1_approved = true;
        current.phase = "development";
        current.status = "phase_2_running";
      }
      savePipeline(current);
      recordAutoRetryScheduled(pipelineId, err, phase);
      if (phase === "planning") {
        reportAgentActivity(pipelineId, {
          status: "phase_1_running",
          phase: "planning",
          current_agent: "A1",
          activity_message: `Planning retry #${current.auto_retry_count} — restarting from A1`,
          activity_level: "warn",
        });
      }
      console.warn(
        `[pipeline-auto-retry] ${pipelineId} ${phase} #${current.auto_retry_count}: ${err.message}`,
      );
    }
  }
}

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

const TargetClarifySchema = z.object({
  confirmed_targets: z.union([z.array(z.string()), z.string()]).optional(),
  target_files: z.union([z.array(z.string()), z.string()]).optional(),
  allow_new_files: z.boolean().optional().default(false),
  notes: z.string().optional(),
});

const RetrySchema = z.object({
  reason: z.string().optional().default(""),
  phase: z.enum(["auto", "planning", "development"]).optional().default("auto"),
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
      description_images: issue.description_images || [],
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
  const threadId = result.graph_thread_id || existing.graph_thread_id || pipelineId;
  const graphState = (await getGraphState(threadId)) || {};
  const rawStatus = await resolveStatus(threadId, { ...graphState, ...result });
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

async function executePlanningPhase(pipelineId, base) {
  if (activeRuns.has(pipelineId)) return;
  startPipelineRun(pipelineId);

  reportAgentActivity(pipelineId, {
    status: "phase_1_running",
    phase: "planning",
    current_agent: "A1",
  });

  try {
    const merged = await runWithPipelineAutoRetry(pipelineId, base, "planning", async (current) => {
      await ensureOllamaReady();
      const result = await runPlanningPhase({ ...current, pipeline_id: pipelineId });
      if (!getPipeline(pipelineId)) return null;
      return mergeGraphResult(pipelineId, current, result);
    });

    if (!merged) return;
    savePipeline(merged);

    if (isJiraConfigured() && base.jira_task?.key) {
      try {
        await addComment(
          base.jira_task.key,
          `SDLC Agents: Phase 1 ${merged.status === "awaiting_target_clarification" ? "paused — confirm which files to edit" : "planning complete"}. Status: ${merged.status}.`,
        );
      } catch {
        // non-blocking
      }
    }
  } catch (err) {
    if (isPipelineCancelledError(err)) {
      console.log(`[pipeline] ${pipelineId} deleted — run stopped`);
      return;
    }
    if (!getPipeline(pipelineId)) return;
    savePipelineFailure(pipelineId, base, err);
  } finally {
    stopPipelineRun(pipelineId);
  }
}

export async function createAndRunPipeline(input) {
  const resolved = await resolvePipelineInput(input);
  const id = uuidv4();
  const now = new Date().toISOString();

  const jiraTask = {
    key: resolved.jira_key,
    summary: resolved.summary,
    description: resolved.description,
    description_images: resolved.description_images || [],
    issue_type: resolved.issue_type,
    priority: resolved.priority,
    status: resolved.status,
    assignee: resolved.assignee,
    url: resolved.url,
  };

  const initial = {
    id,
    pipeline_id: id,
    graph_thread_id: id,
    jira_task: jiraTask,
    phase: "planning",
    status: "phase_1_running",
    current_agent: "A1",
    knowledge_context: null,
    technical_spec: null,
    test_cases: [],
    test_suite_name: null,
    gate_1_approved: null,
    gate_1_feedback: null,
    ...emptyPhase2Fields(),
    error: null,
    failure: null,
    agent_logs: [],
    activity_log: [
      {
        at: now,
        level: "info",
        message: `Pipeline started for ${jiraTask.key}`,
      },
    ],
    created_at: now,
    updated_at: now,
  };

  savePipeline(initial);

  if (isRemoteRepoConfigured()) {
    try {
      await syncRemoteRepository();
    } catch (err) {
      console.warn(`Remote repo sync before planning failed: ${err.message}`);
    }
  }

  executePlanningPhase(id, initial);

  return getPipeline(id);
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

  startPipelineRun(pipelineId);
  try {
    const merged = await runWithPipelineAutoRetry(
      pipelineId,
      existing,
      "development",
      async (current) => {
        await ensureOllamaReady();
        const threadId = current.graph_thread_id || pipelineId;
        const result =
          (current.auto_retry_count || 0) > 0
            ? await retryDevelopmentPhase(current)
            : await resumeGate1(threadId, { approved: true, feedback });
        if (!getPipeline(pipelineId)) return null;
        return mergeGraphResult(pipelineId, current, result);
      },
    );

    if (!merged) {
      return { id: pipelineId, deleted: true };
    }
    savePipeline(merged);

    if (isJiraConfigured() && existing.jira_task?.key) {
      try {
        const phase2Note =
          merged.status === "awaiting_gate_2"
            ? " A7 review, A8 test execution, and A9 report complete. Awaiting Gate 2 — review results before staging."
            : merged.status === "phase_2_complete"
              ? " Phase 2 complete — Gate 2 approved."
              : merged.status === "phase_2_running"
                ? " Phase 2 development in progress."
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
  } catch (err) {
    if (isPipelineCancelledError(err)) {
      console.log(`[pipeline] ${pipelineId} deleted — run stopped`);
      return { id: pipelineId, deleted: true };
    }
    if (getPipeline(pipelineId)) {
      savePipelineFailure(pipelineId, existing, err);
    }
    throw err;
  } finally {
    stopPipelineRun(pipelineId);
  }
}

export async function rejectGate1(pipelineId, feedback = "Rejected by reviewer") {
  const existing = getPipeline(pipelineId);
  if (!existing) {
    throw new Error(`Pipeline not found: ${pipelineId}`);
  }
  if (existing.status !== "awaiting_gate_1") {
    throw new Error(`Pipeline is not awaiting Gate 1 (status: ${existing.status})`);
  }

  const result = await resumeGate1(existing.graph_thread_id || pipelineId, { approved: false, feedback });
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

function hasTargetPaths(targets) {
  if (!targets) return false;
  if (Array.isArray(targets)) return targets.some((t) => String(t).trim());
  return String(targets).trim().length > 0;
}

export async function confirmTargets(pipelineId, input = {}) {
  const existing = getPipeline(pipelineId);
  if (!existing) {
    throw new Error(`Pipeline not found: ${pipelineId}`);
  }
  const status = normalizeStatus(existing.status, existing.phase);
  if (status !== "awaiting_target_clarification") {
    throw new Error(`Pipeline is not awaiting target clarification (status: ${status})`);
  }

  const decision = TargetClarifySchema.parse(input);
  const targets = decision.confirmed_targets || decision.target_files;
  if (!hasTargetPaths(targets) && !decision.allow_new_files) {
    throw new Error(
      'Choose "Create new files" or provide repo-relative paths to edit before continuing',
    );
  }

  startPipelineRun(pipelineId);
  try {
    const merged = await runWithPipelineAutoRetry(
      pipelineId,
      existing,
      "planning",
      async (current) => {
        await ensureOllamaReady();
        const result = await resumeTargetClarify(
          current.graph_thread_id || pipelineId,
          decision,
        );
        if (!getPipeline(pipelineId)) return null;
        return mergeGraphResult(pipelineId, current, result);
      },
    );
    if (!merged) {
      return { id: pipelineId, deleted: true };
    }
    savePipeline(merged);
    return merged;
  } catch (err) {
    if (isPipelineCancelledError(err)) {
      return { id: pipelineId, deleted: true };
    }
    if (getPipeline(pipelineId)) {
      savePipelineFailure(pipelineId, existing, err);
    }
    throw err;
  } finally {
    stopPipelineRun(pipelineId);
  }
}

export async function confirmCodeWrite(pipelineId, input = {}) {
  const existing = getPipeline(pipelineId);
  if (!existing) {
    throw new Error(`Pipeline not found: ${pipelineId}`);
  }
  const status = normalizeStatus(existing.status, existing.phase);
  if (status !== "awaiting_code_clarification") {
    throw new Error(`Pipeline is not awaiting code write clarification (status: ${status})`);
  }

  const decision = TargetClarifySchema.parse(input);

  startPipelineRun(pipelineId);
  try {
    const merged = await runWithPipelineAutoRetry(
      pipelineId,
      existing,
      "development",
      async (current) => {
        await ensureOllamaReady();
        const result =
          (current.auto_retry_count || 0) > 0
            ? await retryDevelopmentPhase(current)
            : await resumeCodeWriteClarify(current.graph_thread_id || pipelineId, decision);
        if (!getPipeline(pipelineId)) return null;
        return mergeGraphResult(pipelineId, current, result);
      },
    );
    if (!merged) {
      return { id: pipelineId, deleted: true };
    }
    savePipeline(merged);
    return merged;
  } catch (err) {
    if (isPipelineCancelledError(err)) {
      return { id: pipelineId, deleted: true };
    }
    if (getPipeline(pipelineId)) {
      savePipelineFailure(pipelineId, existing, err);
    }
    throw err;
  } finally {
    stopPipelineRun(pipelineId);
  }
}

export async function approveGate2(pipelineId, feedback = null) {
  const existing = getPipeline(pipelineId);
  if (!existing) {
    throw new Error(`Pipeline not found: ${pipelineId}`);
  }
  if (existing.status !== "awaiting_gate_2") {
    throw new Error(`Pipeline is not awaiting Gate 2 (status: ${existing.status})`);
  }

  startPipelineRun(pipelineId);
  try {
    const result = await resumeGate2(existing.graph_thread_id || pipelineId, { approved: true, feedback });
    if (!getPipeline(pipelineId)) {
      return { id: pipelineId, deleted: true };
    }
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
  } catch (err) {
    if (isPipelineCancelledError(err)) {
      console.log(`[pipeline] ${pipelineId} deleted — run stopped`);
      return { id: pipelineId, deleted: true };
    }
    throw err;
  } finally {
    stopPipelineRun(pipelineId);
  }
}

export async function rejectGate2(pipelineId, feedback = "Rejected by reviewer") {
  const existing = getPipeline(pipelineId);
  if (!existing) {
    throw new Error(`Pipeline not found: ${pipelineId}`);
  }
  if (existing.status !== "awaiting_gate_2") {
    throw new Error(`Pipeline is not awaiting Gate 2 (status: ${existing.status})`);
  }

  const result = await resumeGate2(existing.graph_thread_id || pipelineId, { approved: false, feedback });
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
    description_images: [],
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

const RETRY_RUNNING_STATUSES = ["pending", "phase_1_running", "phase_2_running"];

function resolveRetryPhase(pipeline, requested) {
  const status = normalizeStatus(pipeline.status, pipeline.phase);
  if (requested !== "auto") return requested;
  if (
    ["awaiting_gate_2", "gate_2_rejected", "phase_2_complete"].includes(status) &&
    pipeline.gate_1_approved
  ) {
    return "development";
  }
  return "planning";
}

export async function retryPipeline(pipelineId, input) {
  const { reason, phase: requestedPhase } = RetrySchema.parse(input);
  const existing = getPipeline(pipelineId);
  if (!existing) {
    throw new Error(`Pipeline not found: ${pipelineId}`);
  }

  const status = normalizeStatus(existing.status, existing.phase);
  if (RETRY_RUNNING_STATUSES.includes(status)) {
    throw new Error(`Pipeline is still running (status: ${status})`);
  }

  const targetPhase = resolveRetryPhase(existing, requestedPhase);
  if (targetPhase === "development" && !existing.technical_spec) {
    throw new Error("Cannot retry development — planning outputs are missing");
  }

  removePipelineWorkspace(pipelineId);

  const retry_count = (existing.retry_count || 0) + 1;
  const graph_thread_id = `${existing.id}::r${retry_count}`;
  const retryEntry = {
    at: new Date().toISOString(),
    reason,
    phase: targetPhase,
    from_status: status,
  };
  const retry_history = [...(existing.retry_history || []), retryEntry];

  const inProgress = {
    ...existing,
    retry_feedback: reason,
    retry_history,
    retry_count,
    graph_thread_id,
    error: null,
    git_publish: null,
    status: targetPhase === "planning" ? "phase_1_running" : "phase_2_running",
    updated_at: new Date().toISOString(),
  };

  if (targetPhase === "planning") {
    Object.assign(inProgress, {
      phase: "planning",
      knowledge_context: null,
      technical_spec: null,
      test_cases: [],
      test_suite_name: null,
      gate_1_approved: null,
      gate_1_feedback: null,
      ...emptyPhase2Fields(),
    });
  } else {
    Object.assign(inProgress, emptyPhase2Fields(), {
      phase: "development",
      gate_2_approved: null,
      gate_2_feedback: null,
    });
  }

  savePipeline(inProgress);

  const runRetry = async () => {
    if (activeRuns.has(existing.id)) return;
    startPipelineRun(existing.id);
    try {
      const merged = await runWithPipelineAutoRetry(
        existing.id,
        inProgress,
        targetPhase,
        async (current) => {
          await ensureOllamaReady();
          const result =
            targetPhase === "planning"
              ? await runPlanningPhase({ ...current, pipeline_id: existing.id })
              : await retryDevelopmentPhase(current);
          if (!getPipeline(existing.id)) return null;
          return mergeGraphResult(existing.id, current, {
            ...result,
            graph_thread_id,
            retry_feedback: reason,
            retry_history,
            retry_count,
          });
        },
      );

      if (!merged) return;
      savePipeline(merged);

      if (isJiraConfigured() && existing.jira_task?.key) {
        try {
          await addComment(
            existing.jira_task.key,
            `SDLC Agents: Pipeline RETRY (${targetPhase}).${reason ? ` Reason: ${reason}` : ""}`,
          );
        } catch {
          // non-blocking
        }
      }
    } catch (err) {
      if (isPipelineCancelledError(err)) {
        console.log(`[pipeline] ${existing.id} deleted — run stopped`);
        return;
      }
      if (!getPipeline(existing.id)) return;
      savePipelineFailure(existing.id, inProgress, err);
    } finally {
      stopPipelineRun(existing.id);
    }
  };

  runRetry();

  return getPipeline(existing.id);
}

export async function removePipelineById(pipelineId) {
  const existing = getPipeline(pipelineId);
  if (!existing) {
    throw new Error(`Pipeline not found: ${pipelineId}`);
  }

  cancelRun(pipelineId);
  activeRuns.delete(pipelineId);

  const repo_revert = revertPipelineRepoChanges(existing);
  let remote_cleanup = { skipped: true };
  try {
    remote_cleanup = await cleanupRemotePublish(existing);
  } catch (err) {
    remote_cleanup = { error: err.message };
  }

  deletePipeline(pipelineId);
  removePipelineWorkspace(pipelineId);

  const revertedCount =
    (repo_revert.files?.restored?.length || 0) +
    (repo_revert.files?.deleted?.length || 0) +
    (repo_revert.files?.git_restored?.length || 0);

  console.log(
    `[pipeline] ${pipelineId} deleted — cancelled run, reverted ${revertedCount} repo file(s)`,
  );

  return {
    id: pipelineId,
    deleted: true,
    jira_key: existing.jira_task?.key,
    repo_revert,
    remote_cleanup,
  };
}

export { CreatePipelineSchema, GateDecisionSchema, RetrySchema, TargetClarifySchema };
