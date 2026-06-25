import fs from "fs";
import path from "path";
import { config } from "../config.js";
import {
  writeFilesToTargetRepo,
  isTargetRepoConfigured,
  getTargetRepoPath,
} from "../integrations/local-repo.js";
import { isRepoWriteEnabled } from "../integrations/repo-target.js";
import {
  captureSnapshotsForWrite,
  saveRepoSnapshotBackup,
} from "../integrations/repo-revert.js";

export function workspacePath(pipelineId) {
  return path.join(config.workspacesDir, pipelineId);
}

function writeToRoot(root, files) {
  const written = [];

  for (const file of files || []) {
    const fullPath = path.join(root, file.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content, "utf-8");
    written.push(file.path);
  }

  return { root, written };
}

function fileSize(root, relPath) {
  try {
    const full = path.join(root, relPath);
    if (!fs.existsSync(full)) return 0;
    return fs.statSync(full).size;
  } catch {
    return 0;
  }
}

export function listWrittenFiles(writeResult) {
  const root =
    writeResult?.target_path ||
    writeResult?.target_repo?.root ||
    writeResult?.sandbox_root ||
    null;
  const paths = writeResult?.written || writeResult?.target_repo?.written || [];

  if (!root || !paths.length) return [];

  return paths.map((relPath) => ({
    path: relPath,
    size: fileSize(root, relPath),
    root,
  }));
}

export function writeCodeFiles(pipelineId, files, priorSnapshots = {}) {
  const snapshotMap = captureSnapshotsForWrite(files, priorSnapshots);
  const writeTarget = isTargetRepoConfigured() && isRepoWriteEnabled();

  if (writeTarget) {
    const target = writeFilesToTargetRepo(files, snapshotMap);
    if (!target.skipped) {
      saveRepoSnapshotBackup(pipelineId, target.snapshot_map);
      console.log(
        `[code-write] pipeline=${pipelineId} → ${target.root} (${target.written.length} file(s): ${target.written.join(", ")})`,
      );
      return {
        sandbox_root: null,
        written: target.written,
        target_repo: target,
        target_path: target.root || getTargetRepoPath(),
        repo_snapshots: target.snapshot_map || snapshotMap,
        write_target: "local_repo",
      };
    }
    console.warn(
      `[code-write] pipeline=${pipelineId} target skipped: ${target.reason} — falling back to sandbox`,
    );
  }

  const sandbox = writeToRoot(workspacePath(pipelineId), files);
  console.log(
    `[code-write] pipeline=${pipelineId} → sandbox ${sandbox.root} (${sandbox.written.length} file(s) — set TARGET_REPO_PATH + TARGET_REPO_WRITE=true for local project writes)`,
  );

  return {
    sandbox_root: sandbox.root,
    written: sandbox.written,
    target_repo: null,
    target_path: null,
    repo_snapshots: snapshotMap,
    write_target: "sandbox_only",
  };
}

export function removePipelineWorkspace(pipelineId) {
  const root = workspacePath(pipelineId);
  if (fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function listWorkspaceFiles(pipelineId, writeResult = null) {
  if (writeResult) {
    return listWrittenFiles(writeResult);
  }

  const root = workspacePath(pipelineId);
  if (!fs.existsSync(root)) return [];

  const results = [];
  function walk(dir, prefix = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else results.push({ path: rel, size: fs.statSync(full).size, root });
    }
  }
  walk(root);
  return results;
}
