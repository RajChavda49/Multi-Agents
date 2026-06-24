import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { config } from "../config.js";

export function isGitLabConfigured() {
  return Boolean(
    config.gitlab.baseUrl && config.gitlab.token && config.gitlab.projectPath,
  );
}

function apiUrl(apiPath) {
  const base = config.gitlab.baseUrl.replace(/\/$/, "");
  return `${base}/api/v4${apiPath}`;
}

async function gitlabRequest(apiPath, options = {}) {
  if (!isGitLabConfigured()) {
    throw new Error("GitLab is not configured. Set GITLAB_BASE_URL, GITLAB_TOKEN, GITLAB_PROJECT_PATH");
  }

  const response = await fetch(apiUrl(apiPath), {
    ...options,
    headers: {
      Accept: "application/json",
      "PRIVATE-TOKEN": config.gitlab.token,
      "Content-Type": "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(60_000),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const msg = data?.message || data?.error || `GitLab API error ${response.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  return data;
}

function encodedProjectPath() {
  return encodeURIComponent(config.gitlab.projectPath);
}

export function getGitLabClonePath() {
  const slug = config.gitlab.projectPath.replace(/\//g, "__");
  return path.join(config.dataDir, "repos", slug);
}

function cloneUrl() {
  const base = config.gitlab.baseUrl.replace(/\/$/, "");
  const token = encodeURIComponent(config.gitlab.token);
  return `https://oauth2:${token}@${base.replace(/^https?:\/\//, "")}/${config.gitlab.projectPath}.git`;
}

function runGit(cmd, cwd) {
  return execSync(cmd, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function getGitLabStatus() {
  if (!isGitLabConfigured()) {
    return {
      configured: false,
      message: "Set GITLAB_BASE_URL, GITLAB_TOKEN, GITLAB_PROJECT_PATH in backend/.env",
    };
  }

  const clonePath = getGitLabClonePath();
  const cloned = fs.existsSync(path.join(clonePath, ".git"));

  return {
    configured: true,
    project_path: config.gitlab.projectPath,
    clone_path: clonePath,
    cloned,
    default_branch: config.gitlab.defaultBranch,
    create_mr: config.gitlab.createMr,
  };
}

export async function testGitLabConnection() {
  const project = await gitlabRequest(`/projects/${encodedProjectPath()}`);
  return {
    connected: true,
    id: project.id,
    name: project.name,
    path_with_namespace: project.path_with_namespace,
    default_branch: project.default_branch,
    web_url: project.web_url,
  };
}

export async function syncGitLabRepository() {
  const clonePath = getGitLabClonePath();
  fs.mkdirSync(path.dirname(clonePath), { recursive: true });

  const branch = config.gitlab.defaultBranch;

  if (!fs.existsSync(path.join(clonePath, ".git"))) {
    runGit(`git clone --branch ${branch} "${cloneUrl()}" "${clonePath}"`, process.cwd());
    return { action: "cloned", path: clonePath, branch };
  }

  runGit("git fetch origin", clonePath);
  runGit(`git checkout ${branch}`, clonePath);
  runGit("git pull origin " + branch, clonePath);
  return { action: "pulled", path: clonePath, branch };
}

export function checkoutPipelineBranch(pipeline) {
  const clonePath = getGitLabClonePath();
  const jiraKey = (pipeline.jira_task?.key || "TASK").replace(/[^A-Za-z0-9-]/g, "");
  const branch = `sdlc/${jiraKey}`;

  try {
    runGit(`git checkout ${config.gitlab.defaultBranch}`, clonePath);
    runGit(`git pull origin ${config.gitlab.defaultBranch}`, clonePath);
  } catch {
    // branch may not exist on remote yet
  }

  try {
    runGit(`git checkout -B ${branch}`, clonePath);
  } catch {
    runGit(`git checkout ${branch}`, clonePath);
  }

  return branch;
}

export async function commitPushAndCreateMr({ branch, title, description }) {
  const clonePath = getGitLabClonePath();

  runGit("git add -A", clonePath);

  let committed = false;
  try {
    const status = runGit("git status --porcelain", clonePath).trim();
    if (status) {
      runGit(`git commit -m ${JSON.stringify(title)}`, clonePath);
      committed = true;
    }
  } catch (err) {
    throw new Error(`Git commit failed: ${err.message}`);
  }

  if (committed) {
    runGit(`git push -u origin ${branch}`, clonePath);
  } else {
    try {
      runGit(`git push -u origin ${branch}`, clonePath);
    } catch {
      // branch may already be on remote
    }
  }

  let mr = null;
  if (config.gitlab.createMr) {
    try {
      mr = await gitlabRequest(`/projects/${encodedProjectPath()}/merge_requests`, {
        method: "POST",
        body: JSON.stringify({
          source_branch: branch,
          target_branch: config.gitlab.defaultBranch,
          title,
          description: description || title,
          remove_source_branch: false,
        }),
      });
    } catch (err) {
      const msg = err.message || "";
      if (/already exists|Another open merge request/i.test(msg)) {
        const existing = await gitlabRequest(
          `/projects/${encodedProjectPath()}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=opened`,
        );
        mr = Array.isArray(existing) ? existing[0] : null;
        if (!mr) throw err;
      } else {
        throw err;
      }
    }
  }

  return {
    committed,
    branch,
    merge_request: mr
      ? {
          iid: mr.iid,
          web_url: mr.web_url,
          title: mr.title,
          state: mr.state,
        }
      : null,
  };
}
