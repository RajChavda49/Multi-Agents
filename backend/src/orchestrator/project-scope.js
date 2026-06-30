import { config } from "../config.js";

/** Whether A5 should run — SKIP_A5=true hard-disables; otherwise A1/A2 decide. */
export function shouldRunBackendAgent(state) {
  if (config.skipBackendAgent) return false;

  const spec = state.technical_spec || {};
  const knowledge = state.knowledge_context || {};
  const backendNeeded = spec.backend_needed ?? knowledge.backend_needed;
  return backendNeeded === true;
}

export function resolveProjectScope(state) {
  const spec = state.technical_spec || {};
  const knowledge = state.knowledge_context || {};

  const scope = spec.project_scope || knowledge.project_scope;
  if (scope === "frontend" || scope === "backend" || scope === "fullstack") {
    return scope;
  }
  if (shouldRunBackendAgent(state)) return "fullstack";
  if (knowledge.change_type === "api" || knowledge.change_type === "data_model") {
    return "backend";
  }
  return "frontend";
}

export function backendSkipReason(state) {
  if (shouldRunBackendAgent(state)) return null;
  const scope = resolveProjectScope(state);
  return `A5 skipped — project scope is ${scope}; A1/A2 determined no backend work needed`;
}
