import {
  isGitLabConfigured,
  getGitLabClonePath,
  syncGitLabRepository,
  checkoutPipelineBranch as checkoutGitLabBranch,
  commitPushAndCreateMr,
  getGitLabStatus,
} from "./gitlab-client.js";
import {
  isGitHubConfigured,
  getGitHubClonePath,
  syncGitHubRepository,
  checkoutPipelineBranch as checkoutGitHubBranch,
  commitPushAndCreatePr,
  getGitHubStatus,
} from "./github-client.js";

export function getRemoteRepoProvider() {
  if (isGitLabConfigured()) return "gitlab";
  if (isGitHubConfigured()) return "github";
  return null;
}

export function getRemoteClonePath() {
  const provider = getRemoteRepoProvider();
  if (provider === "gitlab") return getGitLabClonePath();
  if (provider === "github") return getGitHubClonePath();
  return null;
}

export function getRemoteRepoStatus() {
  if (isGitLabConfigured()) return { provider: "gitlab", ...getGitLabStatus() };
  if (isGitHubConfigured()) return { provider: "github", ...getGitHubStatus() };
  return { provider: null, configured: false };
}

export async function syncRemoteRepository() {
  if (isGitLabConfigured()) return syncGitLabRepository();
  if (isGitHubConfigured()) return syncGitHubRepository();
  throw new Error("No remote repository configured");
}

export function checkoutRemotePipelineBranch(pipeline) {
  if (isGitLabConfigured()) return checkoutGitLabBranch(pipeline);
  if (isGitHubConfigured()) return checkoutGitHubBranch(pipeline);
  return null;
}

export async function commitPushAndCreateMergeRequest({ branch, title, description, jiraKey }) {
  if (isGitLabConfigured()) {
    return commitPushAndCreateMr({ branch, title, description });
  }
  if (isGitHubConfigured()) {
    return commitPushAndCreatePr({ branch, title, description, jiraKey });
  }
  throw new Error("No remote repository configured");
}

export function isRemoteRepoConfigured() {
  return Boolean(getRemoteRepoProvider());
}
