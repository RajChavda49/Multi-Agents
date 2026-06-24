import { getPipeline } from "../storage/pipelines.js";

export class PipelineCancelledError extends Error {
  constructor(pipelineId) {
    super(`Pipeline ${pipelineId} was deleted`);
    this.name = "PipelineCancelledError";
    this.pipelineId = pipelineId;
  }
}

const runControllers = new Map();

export function isPipelineCancelledError(err) {
  return err?.name === "PipelineCancelledError" || err instanceof PipelineCancelledError;
}

export function beginRun(pipelineId) {
  const existing = runControllers.get(pipelineId);
  if (existing) existing.abort();
  const controller = new AbortController();
  runControllers.set(pipelineId, controller);
  return controller.signal;
}

export function endRun(pipelineId) {
  runControllers.delete(pipelineId);
}

export function cancelRun(pipelineId) {
  const controller = runControllers.get(pipelineId);
  if (controller) controller.abort();
  runControllers.delete(pipelineId);
}

export function getRunAbortSignal(pipelineId) {
  return runControllers.get(pipelineId)?.signal;
}

export function assertPipelineActive(pipelineId) {
  if (!pipelineId) return;
  const signal = getRunAbortSignal(pipelineId);
  if (signal?.aborted) {
    throw new PipelineCancelledError(pipelineId);
  }
  if (!getPipeline(pipelineId)) {
    throw new PipelineCancelledError(pipelineId);
  }
}

export function isRunActive(pipelineId) {
  return runControllers.has(pipelineId);
}
