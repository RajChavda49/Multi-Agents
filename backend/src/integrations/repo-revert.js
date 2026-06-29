import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { config } from "../config.js";
import {
  getEffectiveRepoPath,
  isRepoWriteEnabled,
  isRemoteRepoConfigured,
  getRemoteClonePath,
} from "./repo-target.js";
import { isGitHubConfigured } from "./github-client.js";
import { isGitLabConfigured } from "./gitlab-client.js";
import { closePullRequest, deleteRemoteBranch } from "./github-client.js";

const MAX_SNAPSHOT_BYTES = 512_000;
const SNAPSHOT_FILE = ".repo-revert.json";

function workspaceSnapshotPath(pipelineId) {
  return path.join(config.workspacesDir, pipelineId, SNAPSHOT_FILE);
}

function repoRoot() {
  const root = getEffectiveRepoPath();
  return root ? path.resolve(root) : null;
}

function assertInsideRepo(relPath, root) {
  const resolvedRoot = path.resolve(root);
  const rel = String(relPath || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^\.\/+/, "");
  const full = path.resolve(resolvedRoot, rel);
  if (!full.startsWith(resolvedRoot + path.sep) && full !== resolvedRoot) {
    throw new Error(`Unsafe path outside target repo: ${relPath}`);
  }
  return full;
}

function runGit(cmd, cwd) {
  return execSync(cmd, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function isGitRepo(root) {
  return Boolean(root && fs.existsSync(path.join(root, ".git")));
}

function gitRestoreFile(root, relPath) {
  if (!isGitRepo(root)) return false;
  try {
    runGit(`git checkout HEAD -- ${JSON.stringify(relPath)}`, root);
    return true;
  } catch {
    return false;
  }
}

function gitRemoveUntrackedFile(root, relPath) {
  const full = assertInsideRepo(relPath, root);
  if (!fs.existsSync(full)) return true;
  if (isGitRepo(root)) {
    try {
      runGit(`git ls-files --error-unmatch ${JSON.stringify(relPath)}`, root);
      return gitRestoreFile(root, relPath);
    } catch {
      fs.unlinkSync(full);
      return true;
    }
  }
  fs.unlinkSync(full);
  return true;
}

export function captureFileSnapshot(relPath) {
  const root = repoRoot();
  if (!root) {
    return { path: relPath, existed: false, content: null };
  }

  try {
    const full = assertInsideRepo(relPath, root);
    if (!fs.existsSync(full)) {
      return { path: relPath, existed: false, content: null };
    }

    const stat = fs.statSync(full);
    if (!stat.isFile()) {
      return { path: relPath, existed: true, content: null, use_git: true };
    }

    if (stat.size > MAX_SNAPSHOT_BYTES) {
      return { path: relPath, existed: true, content: null, use_git: true };
    }

    return {
      path: relPath,
      existed: true,
      content: fs.readFileSync(full, "utf-8"),
    };
  } catch {
    return { path: relPath, existed: false, content: null };
  }
}

export function saveRepoSnapshotBackup(pipelineId, snapshotMap) {
  if (!snapshotMap || !Object.keys(snapshotMap).length) return;
  const file = workspaceSnapshotPath(pipelineId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(snapshotMap, null, 2), "utf-8");
}

export function loadRepoSnapshotBackup(pipelineId) {
  const file = workspaceSnapshotPath(pipelineId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function mergeSnapshotMaps(existing = {}, incoming = {}) {
  const merged = { ...existing };
  for (const [filePath, snap] of Object.entries(incoming)) {
    if (!merged[filePath]) merged[filePath] = snap;
  }
  return merged;
}

export function captureSnapshotsForWrite(files, priorSnapshots = {}) {
  const merged = { ...priorSnapshots };
  for (const file of files || []) {
    if (!file?.path || merged[file.path]) continue;
    merged[file.path] = captureFileSnapshot(file.path);
  }
  return merged;
}

export function revertSnapshotMap(snapshotMap) {
  const root = repoRoot();
  if (!root || !isRepoWriteEnabled()) {
    return { skipped: true, reason: "repo write disabled or not configured" };
  }

  if (!snapshotMap || !Object.keys(snapshotMap).length) {
    return { skipped: true, reason: "no snapshots recorded for this pipeline" };
  }

  const restored = [];
  const deleted = [];
  const git_restored = [];
  const failed = [];

  for (const snap of Object.values(snapshotMap)) {
    if (!snap?.path) continue;

    try {
      const full = assertInsideRepo(snap.path, root);

      if (snap.existed) {
        if (snap.content != null) {
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, snap.content, "utf-8");
          restored.push(snap.path);
        } else if (gitRestoreFile(root, snap.path)) {
          git_restored.push(snap.path);
        } else {
          failed.push(snap.path);
        }
        continue;
      }

      if (gitRemoveUntrackedFile(root, snap.path)) {
        deleted.push(snap.path);
      } else {
        failed.push(snap.path);
      }
    } catch (err) {
      failed.push(`${snap.path}: ${err.message}`);
    }
  }

  return {
    skipped: false,
    root,
    restored,
    deleted,
    git_restored,
    failed,
  };
}

function revertWrittenPathsWithoutSnapshots(writtenPaths = []) {
  const root = repoRoot();
  if (!root || !writtenPaths.length) return null;

  const git_restored = [];
  const deleted = [];
  const failed = [];

  for (const relPath of writtenPaths) {
    try {
      const full = assertInsideRepo(relPath, root);
      if (!fs.existsSync(full)) continue;

      if (gitRestoreFile(root, relPath)) {
        git_restored.push(relPath);
      } else if (gitRemoveUntrackedFile(root, relPath)) {
        deleted.push(relPath);
      } else {
        failed.push(relPath);
      }
    } catch (err) {
      failed.push(`${relPath}: ${err.message}`);
    }
  }

  return { git_restored, deleted, failed };
}

export function resetPipelineGitBranch(branch) {
  if (!branch || !isRemoteRepoConfigured()) {
    return { skipped: true, reason: "remote repo not configured or no branch" };
  }

  const clonePath = getRemoteClonePath();
  if (!isGitRepo(clonePath)) {
    return { skipped: true, reason: "remote clone is not a git repo" };
  }

  const defaultBranch = isGitLabConfigured()
    ? config.gitlab.defaultBranch
    : config.github.defaultBranch;

  try {
    runGit(`git checkout ${defaultBranch}`, clonePath);
  } catch (err) {
    return { skipped: false, error: `checkout default failed: ${err.message}` };
  }

  try {
    runGit(`git branch -D ${branch}`, clonePath);
    return { skipped: false, checked_out: defaultBranch, deleted_branch: branch };
  } catch {
    return { skipped: false, checked_out: defaultBranch, deleted_branch: null };
  }
}

export async function cleanupRemotePublish(pipeline) {
  const published = pipeline?.git_publish?.merge_request;
  if (!published) return { skipped: true };

  const results = {};

  if (isGitHubConfigured() && published.number) {
    try {
      results.pull_request = await closePullRequest(published.number);
    } catch (err) {
      results.pull_request = { error: err.message };
    }
  }

  if (pipeline.git_branch) {
    results.remote_branch = deleteRemoteBranch(pipeline.git_branch);
  }

  return results;
}

export function revertPipelineRepoChanges(pipeline) {
  const snapshotMap =
    pipeline?.repo_snapshots ||
    loadRepoSnapshotBackup(pipeline?.id) ||
    null;

  let fileRevert = snapshotMap
    ? revertSnapshotMap(snapshotMap)
    : { skipped: true, reason: "no snapshots" };

  if (fileRevert.skipped) {
    const written = pipeline?.code_write_result?.target_repo?.written || [];
    const fallback = revertWrittenPathsWithoutSnapshots(written);
    if (fallback) {
      fileRevert = {
        skipped: false,
        fallback: true,
        ...fallback,
      };
    }
  }

  const branchReset = resetPipelineGitBranch(pipeline?.git_branch);

  const published = pipeline?.git_publish?.merge_request?.web_url;
  if (published) {
    fileRevert.remote_note =
      "Changes may already be pushed or merged — local revert only; close the MR manually if needed.";
    fileRevert.merge_request_url = published;
  }

  return {
    files: fileRevert,
    branch: branchReset,
  };
}
