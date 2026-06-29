export function getRetryPromptContext(state) {
  const blocks = [];

  if (state?.retry_feedback) {
    blocks.push(
      `PRIOR ATTEMPTS — do not repeat failed approaches:\n\n${state.retry_feedback}`,
    );
  }

  if (state?.agent_last_error) {
    blocks.push(`LAST ERROR:\n${state.agent_last_error}`);
  }

  if (state?.escalation_level > 0) {
    blocks.push(
      `ESCALATION LEVEL ${state.escalation_level}: Change strategy. ${
        state.escalation_level >= 2
          ? "Skip paths listed in skip_patch_paths. Prefer NEW files + page wiring over re-patching."
          : "Use numbered_source lines exactly — single-line search/replace only."
      }`,
    );
  }

  if (state?.skip_patch_paths?.length) {
    blocks.push(`DO NOT PATCH these paths (failed repeatedly):\n${state.skip_patch_paths.join("\n")}`);
  }

  if (state?.agent_attempt > 1) {
    blocks.push(`Attempt ${state.agent_attempt} — must differ from previous attempts.`);
  }

  if (!blocks.length) return "";
  return `${blocks.join("\n\n")}\n\n`;
}
