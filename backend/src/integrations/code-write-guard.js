import { config } from "../config.js";
import { fileExistsInRepo, normalizeRelPath } from "./edit-targets.js";

function pathUnderModules(relPath, knowledge) {
  const p = normalizeRelPath(relPath).toLowerCase();
  const modules = (knowledge?.relevant_modules || []).map((m) =>
    String(m).replace(/^src\//, "").toLowerCase(),
  );
  return modules.some((m) => m && p.includes(m.replace(/\/$/, "")));
}

function isAutonomousAllowedNewPath(relPath, knowledge) {
  if (!knowledge?.allow_new_files) return false;
  const p = normalizeRelPath(relPath);
  if (!p.startsWith("src/")) return false;
  if (pathUnderModules(p, knowledge)) return true;
  if (/components\/homepage|pages\/|app\/.*page/i.test(p)) return true;
  return config.autonomousMode;
}

/**
 * Validate source files (A4/A5) against edit_targets.
 * testFiles (A6) are always allowed — they are new test files by definition.
 */
export function validateGeneratedFiles(files, knowledge, testFiles = []) {
  const allowNew = knowledge?.allow_new_files === true;
  const autonomous = config.autonomousMode;
  const editPaths = new Set(
    (knowledge?.edit_targets || [])
      .filter((t) => t.exists !== false)
      .map((t) => normalizeRelPath(t.path)),
  );

  const valid = [];
  const blocked = [];

  for (const file of testFiles || []) {
    const rel = normalizeRelPath(file?.path);
    if (!rel) continue;
    valid.push({ ...file, path: rel });
  }

  for (const file of files || []) {
    const rel = normalizeRelPath(file?.path);
    if (!rel) continue;

    const exists = fileExistsInRepo(rel);
    const onTargetList = editPaths.has(rel);
    const patchResult = file.write_mode === "patch_result" || file.write_mode === "overwrite";

    if (!exists) {
      if (allowNew || isAutonomousAllowedNewPath(rel, knowledge)) {
        valid.push({ ...file, path: rel });
        continue;
      }
      blocked.push({
        path: rel,
        reason: "new file blocked — allow_new_files not set",
      });
      continue;
    }

    if (autonomous && patchResult) {
      valid.push({ ...file, path: rel });
      continue;
    }

    if (autonomous && allowNew && onTargetList) {
      valid.push({ ...file, path: rel });
      continue;
    }

    if (exists && editPaths.size > 0 && !onTargetList && !patchResult) {
      if (autonomous && allowNew && /pages\/|app\/.*page/i.test(rel)) {
        valid.push({ ...file, path: rel });
        continue;
      }
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
    needs_clarification: blocked.length > 0 && !autonomous,
  };
}
