import { config } from "../config.js";
import { LlmCallError } from "../orchestrator/llm.js";

function hintForMessage(message) {
  if (/timeout|aborted/i.test(message)) {
    return "Ollama took too long. Increase OLLAMA_TIMEOUT_MS or retry with a narrower task.";
  }
  if (/invalid JSON/i.test(message)) {
    return "Model returned non-JSON output. Retry or change the Ollama model.";
  }
  if (/fetch failed|ECONNREFUSED/i.test(message)) {
    return "Cannot reach Ollama. Run: ollama serve";
  }
  return "See backend logs or GET /api/health for Ollama status.";
}

export function buildFailureRecord(err, pipeline = {}) {
  const at = new Date().toISOString();

  if (err instanceof LlmCallError) {
    return {
      type: "llm",
      agent: err.agent,
      model: err.model,
      message: err.message,
      hint: err.hint,
      at,
    };
  }

  const inferred = inferFailedAgent(pipeline);
  return {
    type: inferred ? "llm" : "system",
    agent: inferred?.agent || pipeline.current_agent,
    model: inferred?.model || null,
    message: err.message || String(err),
    hint: err instanceof LlmCallError ? err.hint : hintForMessage(err.message || String(err)),
    at,
  };
}

function inferFailedAgent(pipeline) {
  const phase = pipeline.phase;
  if (phase === "planning") {
    if (!pipeline.knowledge_context) return { agent: "A1", model: config.reasoningModel };
    if (!pipeline.technical_spec) return { agent: "A2", model: config.reasoningModel };
    if (!pipeline.test_cases?.length) return { agent: "A3", model: config.reasoningModel };
  }
  if (phase === "development") {
    if (!pipeline.frontend_code && !pipeline.backend_code) {
      return { agent: "A4-A6", model: config.codingModel };
    }
    if (!pipeline.code_review) return { agent: "A7", model: config.reasoningModel };
    if (!pipeline.test_execution) return { agent: "A8", model: config.reasoningModel };
    if (!pipeline.execution_report) return { agent: "A9", model: config.reasoningModel };
  }
  return null;
}

export function failureSummary(failure) {
  if (!failure) return null;
  const parts = [failure.agent, failure.model].filter(Boolean);
  const prefix = parts.length ? `${parts.join(" · ")}: ` : "";
  return `${prefix}${failure.message}`;
}
