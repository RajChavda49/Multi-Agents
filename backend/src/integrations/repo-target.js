import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { config } from "../config.js";
import {
  getRemoteRepoProvider,
  getRemoteClonePath,
  getRemoteRepoStatus,
  syncRemoteRepository,
  checkoutRemotePipelineBranch,
  commitPushAndCreateMergeRequest,
  isRemoteRepoConfigured,
} from "./remote-repo.js";
import { isGitLabConfigured, getGitLabClonePath } from "./gitlab-client.js";
import { isGitHubConfigured, getGitHubClonePath } from "./github-client.js";

function isClonedRepo(dir) {
  return Boolean(dir && fs.existsSync(path.join(dir, ".git")));
}

export function getEffectiveRepoPath() {
  if (isGitLabConfigured()) {
    const gitlabPath = getGitLabClonePath();
    if (isClonedRepo(gitlabPath)) return gitlabPath;
  }
  if (isGitHubConfigured()) {
    const githubPath = getGitHubClonePath();
    if (isClonedRepo(githubPath)) return githubPath;
  }
  if (config.targetRepo.path) {
    const local = path.resolve(config.targetRepo.path);
    if (fs.existsSync(local)) return local;
  }
  return null;
}

export function isRepoWriteEnabled() {
  if (isGitLabConfigured()) return config.gitlab.writeEnabled;
  if (isGitHubConfigured()) return config.github.writeEnabled;
  return config.targetRepo.writeEnabled;
}

function describeConnectedRepo(clonePath) {
  let name;
  let stack;

  if (clonePath && fs.existsSync(clonePath)) {
    try {
      const raw = fs.readFileSync(path.join(clonePath, "package.json"), "utf-8");
      const pkg = JSON.parse(raw);
      name = pkg?.name || path.basename(clonePath);
      const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
      stack = [];
      if (deps?.next) stack.push("next.js");
      if (deps?.react) stack.push("react");
      if (deps?.express) stack.push("express");
      if (deps?.vite) stack.push("vite");
      if (stack.length === 0) stack.push("node.js");
    } catch {
      name = path.basename(clonePath);
      stack = ["unknown"];
    }
  }

  return { name, stack };
}

export function getCombinedRepoStatus() {
  const remote = getRemoteRepoStatus();
  if (remote.configured) {
    const clonePath = remote.clone_path;
    const remoteConnected = remote.cloned && fs.existsSync(clonePath);
    const effectivePath = getEffectiveRepoPath();
    const usingLocalFallback =
      !remoteConnected &&
      effectivePath &&
      config.targetRepo.path &&
      path.resolve(config.targetRepo.path) === effectivePath;

    const { name, stack } = describeConnectedRepo(
      remoteConnected ? clonePath : usingLocalFallback ? effectivePath : null,
    );

    return {
      source: usingLocalFallback ? "local" : remote.provider,
      configured: true,
      connected: remoteConnected || usingLocalFallback,
      path: remoteConnected ? clonePath : usingLocalFallback ? effectivePath : clonePath,
      name,
      stack,
      ...remote,
      remote_provider: remote.provider,
      remote_connected: remoteConnected,
      using_local_fallback: usingLocalFallback,
      write_enabled: usingLocalFallback
        ? config.targetRepo.writeEnabled
        : remote.provider === "gitlab"
          ? config.gitlab.writeEnabled
          : config.github.writeEnabled,
      create_mr: remote.provider === "gitlab" ? remote.create_mr : remote.create_pr,
    };
  }

  const localPath = config.targetRepo.path ? path.resolve(config.targetRepo.path) : null;
  if (!localPath) {
    return {
      source: "none",
      configured: false,
      message: "Set GITHUB_*, GITLAB_*, or TARGET_REPO_PATH in backend/.env",
    };
  }

  return {
    source: "local",
    configured: true,
    connected: fs.existsSync(localPath),
    path: localPath,
    write_enabled: config.targetRepo.writeEnabled,
  };
}

function runGit(cmd, cwd) {
  return execSync(cmd, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function ensureRepoReady(pipeline) {
  if (isRemoteRepoConfigured()) {
    await syncRemoteRepository();
    const branch = checkoutRemotePipelineBranch(pipeline);
    return {
      source: getRemoteRepoProvider(),
      path: getRemoteClonePath(),
      branch,
    };
  }

  const localPath = getEffectiveRepoPath();
  if (localPath && fs.existsSync(localPath)) {
    return { source: "local", path: localPath, branch: null };
  }

  return { source: "none", path: null, branch: null };
}

export async function publishPipelineChanges(pipeline) {
  const provider = getRemoteRepoProvider();
  if (!provider) {
    return { skipped: true, reason: "Remote repo not configured" };
  }

  const writeEnabled = provider === "gitlab" ? config.gitlab.writeEnabled : config.github.writeEnabled;
  if (!writeEnabled) {
    return { skipped: true, reason: `${provider} write disabled` };
  }

  const jiraKey = pipeline.jira_task?.key || pipeline.id.slice(0, 8);
  const branch = pipeline.git_branch || `sdlc/${jiraKey}`;
  const title = `SDLC Agents: ${jiraKey} — ${pipeline.jira_task?.summary || "automated changes"}`;

  return commitPushAndCreateMergeRequest({
    branch,
    title,
    jiraKey,
    description: [
      `Automated changes from SDLC Agents pipeline \`${pipeline.id}\`.`,
      `Jira task: **${jiraKey}**`,
      pipeline.gate_2_feedback ? `Gate 2 note: ${pipeline.gate_2_feedback}` : null,
      pipeline.execution_report?.overview || null,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
}

export function getRepoGitInfo() {
  const repoPath = getEffectiveRepoPath();
  if (!repoPath || !fs.existsSync(path.join(repoPath, ".git"))) {
    return null;
  }

  try {
    const branch = runGit("git rev-parse --abbrev-ref HEAD", repoPath).trim();
    const commit = runGit("git rev-parse --short HEAD", repoPath).trim();
    return { branch, commit, path: repoPath };
  } catch {
    return null;
  }
}

export { isRemoteRepoConfigured, getRemoteRepoProvider, getRemoteClonePath };
