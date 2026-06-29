import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { config } from "../config.js";

export function parseGitHubProjectPath(input) {
  if (!input) return null;
  let value = String(input).trim().replace(/\/$/, "").replace(/\.git$/i, "");
  const fromUrl = value.match(/github\.com[/:]([^/]+)\/([^/]+)/i);
  if (fromUrl) return `${fromUrl[1]}/${fromUrl[2]}`;
  if (/^[^/\s]+\/[^/\s]+$/.test(value)) return value;
  return null;
}

export function isGitHubConfigured() {
  return Boolean(config.github.token && parseGitHubProjectPath(config.github.projectPath));
}

function projectParts() {
  const projectPath = parseGitHubProjectPath(config.github.projectPath);
  if (!projectPath) {
    throw new Error("Invalid GITHUB_PROJECT_PATH — use owner/repo or a github.com URL");
  }
  const [owner, repo] = projectPath.split("/");
  return { owner, repo, projectPath };
}

function githubHost() {
  const base = (config.github.baseUrl || "https://github.com").replace(/\/$/, "");
  try {
    return new URL(base).host;
  } catch {
    return "github.com";
  }
}

function apiBaseUrl() {
  const host = githubHost();
  if (host === "github.com") return "https://api.github.com";
  return `https://${host}/api/v3`;
}

function apiUrl(apiPath) {
  return `${apiBaseUrl()}${apiPath}`;
}

async function githubRequest(apiPath, options = {}) {
  if (!isGitHubConfigured()) {
    throw new Error("GitHub is not configured. Set GITHUB_TOKEN and GITHUB_PROJECT_PATH");
  }

  const response = await fetch(apiUrl(apiPath), {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.github.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
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
    const msg = data?.message || data?.error || `GitHub API error ${response.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  return data;
}

export function getGitHubClonePath() {
  const projectPath = parseGitHubProjectPath(config.github.projectPath);
  const slug = projectPath.replace(/\//g, "__");
  return path.join(config.dataDir, "repos", `gh__${slug}`);
}

function cloneUrl() {
  const { owner, repo } = projectParts();
  const token = encodeURIComponent(config.github.token);
  const host = githubHost();
  return `https://x-access-token:${token}@${host}/${owner}/${repo}.git`;
}

function runGit(cmd, cwd) {
  return execSync(cmd, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function getGitHubStatus() {
  if (!isGitHubConfigured()) {
    return {
      configured: false,
      message: "Set GITHUB_TOKEN and GITHUB_PROJECT_PATH (owner/repo) in backend/.env",
    };
  }

  const clonePath = getGitHubClonePath();
  const cloned = fs.existsSync(path.join(clonePath, ".git"));

  return {
    configured: true,
    project_path: parseGitHubProjectPath(config.github.projectPath),
    clone_path: clonePath,
    cloned,
    default_branch: config.github.defaultBranch,
    create_pr: config.github.createPr,
  };
}

export async function testGitHubConnection() {
  const { owner, repo } = projectParts();
  const project = await githubRequest(`/repos/${owner}/${repo}`);
  return {
    connected: true,
    id: project.id,
    name: project.name,
    full_name: project.full_name,
    default_branch: project.default_branch,
    html_url: project.html_url,
  };
}

async function resolveGitHubDefaultBranch() {
  try {
    const info = await testGitHubConnection();
    if (info?.default_branch) return info.default_branch;
  } catch (err) {
    console.warn(`GitHub API unavailable for default branch: ${err.message}`);
  }
  return config.github.defaultBranch;
}

function removeIncompleteClone(clonePath) {
  if (fs.existsSync(clonePath) && !fs.existsSync(path.join(clonePath, ".git"))) {
    fs.rmSync(clonePath, { recursive: true, force: true });
  }
}

function cloneGitHubRepo(clonePath, branch) {
  const url = cloneUrl();
  try {
    runGit(`git clone --branch ${branch} "${url}" "${clonePath}"`, process.cwd());
    return branch;
  } catch (err) {
    removeIncompleteClone(clonePath);
    const fallbacks = [...new Set([branch, "main", "master"])].filter(Boolean);
    for (const candidate of fallbacks) {
      if (candidate === branch) continue;
      try {
        runGit(`git clone --branch ${candidate} "${url}" "${clonePath}"`, process.cwd());
        return candidate;
      } catch {
        removeIncompleteClone(clonePath);
      }
    }
    runGit(`git clone "${url}" "${clonePath}"`, process.cwd());
    return runGit("git rev-parse --abbrev-ref HEAD", clonePath).trim();
  }
}

export async function syncGitHubRepository() {
  const clonePath = getGitHubClonePath();
  fs.mkdirSync(path.dirname(clonePath), { recursive: true });

  let branch = await resolveGitHubDefaultBranch();

  if (!fs.existsSync(path.join(clonePath, ".git"))) {
    branch = cloneGitHubRepo(clonePath, branch);
    return { action: "cloned", path: clonePath, branch };
  }

  runGit("git fetch origin", clonePath);
  try {
    runGit(`git checkout ${branch}`, clonePath);
    runGit(`git pull origin ${branch}`, clonePath);
  } catch {
    const detected = runGit("git rev-parse --abbrev-ref HEAD", clonePath).trim();
    branch = detected || branch;
    try {
      runGit(`git pull origin ${branch}`, clonePath);
    } catch {
      // remote branch may not exist yet
    }
  }
  return { action: "pulled", path: clonePath, branch };
}

export function checkoutPipelineBranch(pipeline) {
  const clonePath = getGitHubClonePath();
  const jiraKey = (pipeline.jira_task?.key || "TASK").replace(/[^A-Za-z0-9-]/g, "");
  const branch = `sdlc/${jiraKey}`;

  try {
    runGit(`git checkout ${config.github.defaultBranch}`, clonePath);
    runGit(`git pull origin ${config.github.defaultBranch}`, clonePath);
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

export async function commitPushAndCreatePr({ branch, title, description, jiraKey }) {
  const clonePath = getGitHubClonePath();
  const { owner, repo } = projectParts();

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

  let pr = null;
  if (config.github.createPr) {
    const prTitle = jiraKey ? `[${jiraKey}] ${title.replace(/^SDLC Agents:\s*[^—]+—\s*/i, "")}` : title;
    const prBody = [
      jiraKey ? `Jira: **${jiraKey}**` : null,
      description || title,
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      pr = await githubRequest(`/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        body: JSON.stringify({
          title: prTitle,
          head: branch,
          base: config.github.defaultBranch,
          body: prBody,
        }),
      });
    } catch (err) {
      const msg = err.message || "";
      if (/already exists|A pull request already exists/i.test(msg)) {
        const existing = await githubRequest(
          `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
        );
        pr = Array.isArray(existing) ? existing[0] : null;
        if (!pr) throw err;
      } else {
        throw err;
      }
    }
  }

  return {
    committed,
    branch,
    merge_request: pr
      ? {
          iid: pr.number,
          number: pr.number,
          web_url: pr.html_url,
          title: pr.title,
          state: pr.state,
        }
      : null,
  };
}

export async function closePullRequest(prNumber) {
  if (!prNumber) return { skipped: true };
  const { owner, repo } = projectParts();
  const pr = await githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
  });
  return {
    closed: true,
    number: pr.number,
    web_url: pr.html_url,
    state: pr.state,
  };
}

export function deleteRemoteBranch(branch) {
  const clonePath = getGitHubClonePath();
  if (!branch || !fs.existsSync(path.join(clonePath, ".git"))) {
    return { skipped: true };
  }
  try {
    runGit(`git push origin --delete ${branch}`, clonePath);
    return { deleted: true, branch };
  } catch (err) {
    return { deleted: false, branch, error: err.message };
  }
}
