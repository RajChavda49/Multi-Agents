const API_BASE = "/api";

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

export const api = {
  health: () => request("/health"),
  listPipelines: () => request("/pipelines"),
  getPipeline: (id) => request(`/pipelines/${id}`),
  deletePipeline: (id) => request(`/pipelines/${id}`, { method: "DELETE" }),
  createPipeline: (body) =>
    request("/pipelines", { method: "POST", body: JSON.stringify(body) }),
  createPipelineFromJira: (key) =>
    request(`/pipelines/from-jira/${encodeURIComponent(key)}`, { method: "POST" }),
  approveGate1: (id, feedback) =>
    request(`/pipelines/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ feedback }),
    }),
  rejectGate1: (id, feedback) =>
    request(`/pipelines/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ feedback }),
    }),
  confirmTargets: (id, body) =>
    request(`/pipelines/${id}/confirm-targets`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  confirmCodeWrite: (id, body) =>
    request(`/pipelines/${id}/confirm-code-write`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  approveGate2: (id, feedback) =>
    request(`/pipelines/${id}/approve-gate-2`, {
      method: "POST",
      body: JSON.stringify({ feedback }),
    }),
  rejectGate2: (id, feedback) =>
    request(`/pipelines/${id}/reject-gate-2`, {
      method: "POST",
      body: JSON.stringify({ feedback }),
    }),
  retryPipeline: (id, reason, phase = "auto") =>
    request(`/pipelines/${id}/retry`, {
      method: "POST",
      body: JSON.stringify({ reason, phase }),
    }),
  jiraStatus: () => request("/jira/status"),
  repoStatus: () => request("/repo/status"),
  gitlabStatus: () => request("/gitlab/status"),
  gitlabSync: () => request("/gitlab/sync", { method: "POST" }),
  githubStatus: () => request("/github/status"),
  githubSync: () => request("/github/sync", { method: "POST" }),
  jiraTasks: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.jql) qs.set("jql", params.jql);
    if (params.limit) qs.set("limit", String(params.limit));
    const query = qs.toString();
    return request(`/jira/tasks${query ? `?${query}` : ""}`);
  },
  jiraTask: (key) => request(`/jira/tasks/${encodeURIComponent(key)}`),
};
