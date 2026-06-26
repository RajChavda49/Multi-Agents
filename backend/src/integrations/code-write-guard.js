import { fileExistsInRepo, normalizeRelPath } from "./edit-targets.js";

/**
 * Validate source files (A4/A5) against edit_targets.
 * testFiles (A6) are always allowed — they are new test files by definition.
 */
export function validateGeneratedFiles(files, knowledge, testFiles = []) {
  const allowNew = knowledge?.allow_new_files === true;
  const editPaths = new Set(
    (knowledge?.edit_targets || [])
      .filter((t) => t.exists !== false)
      .map((t) => normalizeRelPath(t.path)),
  );

  const valid = [];
  const blocked = [];

  // A6 test files — always valid, always allowed as new files
  for (const file of testFiles || []) {
    const rel = normalizeRelPath(file?.path);
    if (!rel) continue;
    valid.push({ ...file, path: rel });
  }

  // A4/A5 source files — checked against edit_targets
  for (const file of files || []) {
    const rel = normalizeRelPath(file?.path);
    if (!rel) continue;

    const exists = fileExistsInRepo(rel);
    const onTargetList = editPaths.has(rel);

    if (!exists && !allowNew) {
      blocked.push({
        path: rel,
        reason: onTargetList
          ? "path listed but not found in repo"
          : "new file blocked — edit existing files only (confirm targets or allow new files)",
      });
      continue;
    }

    if (!exists && allowNew) {
      valid.push({ ...file, path: rel });
      continue;
    }

    if (exists && editPaths.size > 0 && !onTargetList) {
      blocked.push({
        path: rel,
        reason: `not in confirmed edit_targets: ${[...editPaths].join(", ")}`,
      });
      continue;
    }

    valid.push({ ...file, path: rel });
  }

  return {
    valid,
    blocked,
    needs_clarification: blocked.length > 0,
  };
}
