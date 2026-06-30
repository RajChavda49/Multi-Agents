import { config } from "../config.js";
import { getPipeline, savePipeline } from "../storage/pipelines.js";
import { logPipelineEvent } from "./pipeline-progress.js";
import { isRecoverableAgentError } from "./agent-retry.js";
import { isPipelineCancelledError } from "./pipeline-run-control.js";

export function isRecoverablePipelineError(err) {
  return isRecoverableAgentError(err);
}

export function canAutoRetryPipeline(pipeline) {
  if (!config.pipelineAutoRetryEnabled) return false;
  const count = pipeline.auto_retry_count || 0;
  return count < config.pipelineAutoRetryMax;
}

export function appendAutoRetryFeedback(existingFeedback, err, attempt) {
  const msg = err?.message || String(err);
  const block = `Pipeline auto-retry ${attempt}: ${msg}`;
  return existingFeedback ? `${existingFeedback}\n\n${block}` : block;
}

export function preparePipelineForAutoRetry(pipeline, err, phase = "planning") {
  const auto_retry_count = (pipeline.auto_retry_count || 0) + 1;
  const retry_feedback = appendAutoRetryFeedback(pipeline.retry_feedback, err, auto_retry_count);
  const graph_thread_id =
    phase === "development"
      ? `${pipeline.id}::ar${auto_retry_count}`
      : `${pipeline.id}::pr${auto_retry_count}`;

  const base = {
    ...pipeline,
    auto_retry_count,
    retry_feedback,
    graph_thread_id,
    error: null,
    failure: null,
    current_agent: phase === "planning" ? "A1" : pipeline.current_agent,
    updated_at: new Date().toISOString(),
  };

  if (phase === "planning") {
    return {
      ...base,
      phase: "planning",
      status: "phase_1_running",
      knowledge_context: null,
      technical_spec: null,
      test_cases: [],
      test_suite_name: null,
      gate_1_approved: null,
      gate_1_feedback: null,
    };
  }

  return {
    ...base,
    gate_1_approved: true,
    phase: "development",
    status: "phase_2_running",
  };
}

export function recordAutoRetryScheduled(pipelineId, err, phase) {
  logPipelineEvent(pipelineId, {
    level: "warn",
    message: `Scheduling ${phase} auto-retry: ${err?.message || err}`,
  });
}

export function recordAutoRetryExhausted(pipelineId, err) {
  logPipelineEvent(pipelineId, {
    level: "error",
    message: `Auto-retry limit reached — ${err?.message || err}`,
  });
}

export function shouldStopAutoRetry(err) {
  return isPipelineCancelledError(err) || !isRecoverablePipelineError(err);
}
