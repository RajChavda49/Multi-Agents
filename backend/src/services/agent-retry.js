import { config } from "../config.js";
import { logPipelineEvent } from "./pipeline-progress.js";

function errorSignature(err) {
  const msg = err?.message || String(err);
  const path = err?.patchFailure?.path || msg.match(/in ([^\s—]+)/)?.[1];
  const kind = msg.includes("search block not found")
    ? "search_not_found"
    : msg.includes("invalid JSON") || msg.includes("truncated")
      ? "invalid_json"
      : msg.includes("truncate")
      ? "truncate"
      : msg.includes("not found in repo")
        ? "missing_file"
        : "other";
  return path ? `${kind}:${path}` : `${kind}:${msg.slice(0, 100)}`;
}

export function buildAgentRetryFeedback(err, agentId, attempt, meta = {}) {
  const msg = err?.message || String(err);
  const repeat = meta.sameErrorRepeat === true;
  const escalation = meta.escalationLevel || 0;
  const pf = err?.patchFailure;

  let hint = "Fix the error and try again.";

  if (repeat && escalation >= 2) {
    hint =
      "Switch to CREATE mode: new component files + wire in page. Do not patch failed paths.";
  } else if (config.autonomousMode && /search block not found/i.test(msg)) {
    hint =
      "Patch failed — create NEW files instead of re-patching. Use suggested_new_file_paths.";
  } else if (pf) {
    hint = `${pf.recovery_hint}${
      pf.verbatim_anchors?.length
        ? `\nValid anchors:\n${pf.verbatim_anchors.map((a) => `  ${JSON.stringify(a)}`).join("\n")}`
        : ""
    }${
      pf.nearby_lines?.length
        ? `\nNearby lines:\n${pf.nearby_lines.map((l) => `  L${l.line_no}: ${l.text}`).join("\n")}`
        : ""
    }`;
  } else if (/file not found in repo/i.test(msg)) {
    hint =
      'File missing — add it in "files" with FULL content (new path only). Existing files need "edits".';
  } else if (/truncate original|would truncate|stub|too short/i.test(msg)) {
    hint =
      'Use {"edits":[{path,search,replace}]} for existing files — never stub "files" for paths that exist.';
  } else if (/search block not found/i.test(msg)) {
    hint =
      escalation >= 1
        ? "Use numbered_source in the prompt — copy ONE full line character-for-character as search."
        : "Copy search from verbatim_anchors or a single complete line from the excerpt.";
  } else if (/invalid JSON|truncated|malformed JSON/i.test(msg)) {
    hint =
      "JSON was truncated. Output ONE deliverable per files[] entry. Keep code compact — no markdown fences.";
  } else if (/incomplete: missing deliverable/i.test(msg)) {
    hint =
      "Missing deliverable — add a files[] entry for each item in deliverables_checklist. One component per deliverable.";
  }

  const escalationNote =
    escalation > 0
      ? `\nEscalation level ${escalation} — you must change approach, not repeat the failed edit.`
      : "";

  return `Auto-retry ${attempt} for ${agentId} failed: ${msg}

${hint}${escalationNote}`;
}

export function isRecoverableAgentError(err) {
  const msg = err?.message || String(err);
  if (/cancelled|deleted|not awaiting|not found: pipeline/i.test(msg)) return false;
  if (/gate.*reject/i.test(msg)) return false;
  return true;
}

export async function runAgentWithRetry(agentId, pipelineId, runFn, initialState = {}) {
  const max = config.agentAutoRetryMax;
  let feedback = initialState.retry_feedback || "";
  let lastError;
  let escalationLevel = initialState.escalation_level || 0;
  const failedPatchPaths = { ...(initialState.failed_patch_paths || {}) };
  const skipPatchPaths = new Set(initialState.skip_patch_paths || []);
  const signatures = new Map();

  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await runFn({
        ...initialState,
        retry_feedback: feedback,
        agent_attempt: attempt,
        agent_last_error: lastError?.message || null,
        escalation_level: escalationLevel,
        failed_patch_paths: failedPatchPaths,
        skip_patch_paths: [...skipPatchPaths],
      });
    } catch (err) {
      lastError = err;
      if (!isRecoverableAgentError(err) || attempt >= max) break;

      const sig = errorSignature(err);
      const failCount = (signatures.get(sig) || 0) + 1;
      signatures.set(sig, failCount);
      const sameErrorRepeat = failCount >= 2;

      // First failure → next attempt escalates (numbered source). Second+ → skip path / alternate mode.
      escalationLevel = Math.max(escalationLevel, failCount);

      if (err.patchFailure?.path) {
        if (failCount >= 2 || (config.autonomousMode && failCount >= 1 && sig.startsWith("search_not_found"))) {
          skipPatchPaths.add(err.patchFailure.path);
        }
      }

      if (err.patchFailure) {
        failedPatchPaths[err.patchFailure.path] = err.patchFailure;
      }

      const extra = buildAgentRetryFeedback(err, agentId, attempt, {
        sameErrorRepeat,
        escalationLevel,
      });
      feedback = feedback ? `${feedback}\n\n${extra}` : extra;

      const strategyNote =
        escalationLevel >= 2
          ? ` — escalating (level ${escalationLevel}), skipping: ${[...skipPatchPaths].join(", ") || "n/a"}`
          : "";

      logPipelineEvent(pipelineId, {
        level: "warn",
        agent: agentId,
        message: `Auto-retry ${attempt}/${max}: ${err.message}${strategyNote}`,
      });
      console.warn(`[agent-retry] ${agentId} attempt ${attempt}/${max} (esc ${escalationLevel}): ${err.message}`);
    }
  }

  throw lastError;
}
