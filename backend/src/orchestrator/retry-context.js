export function getRetryPromptContext(state) {
  if (!state?.retry_feedback) return "";
  return `IMPORTANT — The user requested a retry because the previous output was not satisfactory. Address this feedback in your response:

${state.retry_feedback}

`;
}
