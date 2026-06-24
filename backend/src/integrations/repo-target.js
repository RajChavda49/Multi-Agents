import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { config } from "../config.js";
import {
  isGitLabConfigured,
  getGitLabClonePath,
  syncGitLabRepository,
  checkoutPipelineBranch,
  commitPushAndCreateMr,
  getGitLabStatus,
} from "./gitlab-client.js";

export function getEffectiveRepoPath() {
  if (isGitLabConfigured()) {
    return getGitLabClonePath();
  }
  if (config.targetRepo.path) {
    return path.resolve(config.targetRepo.path);
  }
  return null;
}

export function isRepoWriteEnabled() {
  if (isGitLabConfigured()) return config.gitlab.writeEnabled;
  return config.targetRepo.writeEnabled;
}

export function getCombinedRepoStatus() {
  if (isGitLabConfigured()) {
    const gitlab = getGitLabStatus();
    const clonePath = gitlab.clone_path;
    const connected = gitlab.cloned && fs.existsSync(clonePath);
    let name;
    let stack;

    if (connected) {
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

    return {
      source: "gitlab",
      configured: true,
      connected,
      path: clonePath,
      name,
      stack,
      ...gitlab,
      write_enabled: config.gitlab.writeEnabled,
    };
  }

  const localPath = config.targetRepo.path ? path.resolve(config.targetRepo.path) : null;
  if (!localPath) {
    return {
      source: "none",
      configured: false,
      message: "Set GITLAB_* or TARGET_REPO_PATH in backend/.env",
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
  if (isGitLabConfigured()) {
    await syncGitLabRepository();
    const branch = checkoutPipelineBranch(pipeline);
    return {
      source: "gitlab",
      path: getGitLabClonePath(),
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
  if (!isGitLabConfigured() || !config.gitlab.writeEnabled) {
    return { skipped: true, reason: "GitLab write disabled or not configured" };
  }

  const jiraKey = pipeline.jira_task?.key || pipeline.id.slice(0, 8);
  const branch = pipeline.git_branch || `sdlc/${jiraKey}`;
  const title = `SDLC Agents: ${jiraKey} — ${pipeline.jira_task?.summary || "automated changes"}`;

  return commitPushAndCreateMr({
    branch,
    title,
    description: [
      `Automated changes from SDLC Agents pipeline \`${pipeline.id}\`.`,
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
