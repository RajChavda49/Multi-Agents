import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { writeFilesToTargetRepo, isTargetRepoConfigured } from "../integrations/local-repo.js";

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

export function writeCodeFiles(pipelineId, files) {
  const sandbox = writeToRoot(workspacePath(pipelineId), files);
  const target = isTargetRepoConfigured() ? writeFilesToTargetRepo(files) : null;

  return {
    sandbox_root: sandbox.root,
    written: sandbox.written,
    target_repo: target,
    write_target: target?.skipped ? "sandbox_only" : target ? "sandbox_and_local_repo" : "sandbox_only",
  };
}

export function removePipelineWorkspace(pipelineId) {
  const root = workspacePath(pipelineId);
  if (fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function listWorkspaceFiles(pipelineId) {
  const root = workspacePath(pipelineId);
  if (!fs.existsSync(root)) return [];

  const results = [];
  function walk(dir, prefix = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else results.push({ path: rel, size: fs.statSync(full).size });
    }
  }
  walk(root);
  return results;
}
