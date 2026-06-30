import { fileExistsInRepo, normalizeRelPath } from "../integrations/edit-targets.js";
import {
  deliverablePaths,
  parseTaskDeliverables,
} from "./task-deliverables.js";

export function isGreenfieldTask(knowledge, jiraTask) {
  const desc = `${jiraTask?.summary || ""} ${jiraTask?.description || ""}`;
  return (
    knowledge?.change_type === "full_feature" ||
    knowledge?.change_scope === "long" ||
    /\b(new|create|build|add)\s+(a\s+)?(page|feature|component|homepage|landing|section|screen)\b/i.test(
      desc,
    ) ||
    /\b(home\s*page|homepage|ecommerce\s+home|landing\s+page)\b/i.test(desc)
  );
}

export function isPatchPreferredTask(knowledge, jiraTask) {
  return (
    knowledge?.change_scope === "short" &&
    (knowledge?.change_type === "ui_copy" ||
      knowledge?.change_type === "bugfix" ||
      /\b(replace|update|change|fix|edit)\s+(text|copy|label|wording)\b/i.test(
        `${jiraTask?.summary || ""} ${jiraTask?.description || ""}`,
      ))
  );
}

/** Suggest new file paths from task deliverables + modules. */
export function suggestNewFilePaths(knowledge, jiraTask) {
  const paths = new Set();

  const deliverables = knowledge?.task_deliverables?.length
    ? knowledge.task_deliverables
    : parseTaskDeliverables(jiraTask).deliverables;

  for (const p of deliverablePaths(deliverables)) {
    paths.add(p);
  }

  for (const m of knowledge?.relevant_modules || []) {
    const mod = String(m).replace(/^\/+/, "").replace(/\/+$/, "");
    if (!mod || /\.(js|jsx|ts|tsx)$/i.test(mod)) continue;
    const base = mod.startsWith("src/") ? mod : `src/${mod}`;
    paths.add(`${base}/index.js`);
  }

  return [...paths].filter((p) => !fileExistsInRepo(normalizeRelPath(p)));
}
