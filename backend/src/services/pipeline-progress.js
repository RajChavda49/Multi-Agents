import { getPipeline, savePipeline } from "../storage/pipelines.js";

export function reportAgentActivity(pipelineId, patch) {
  const existing = getPipeline(pipelineId);
  if (!existing) return;

  savePipeline({
    ...existing,
    ...patch,
    updated_at: new Date().toISOString(),
  });
}
