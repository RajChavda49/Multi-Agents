import { fileExistsInRepo, normalizeRelPath } from "../integrations/edit-targets.js";

export function isGreenfieldTask(knowledge, jiraTask) {
  const desc = `${jiraTask?.summary || ""} ${jiraTask?.description || ""}`;
  return (
    knowledge?.change_type === "full_feature" ||
    knowledge?.change_scope === "long" ||
    knowledge?.allow_new_files === true ||
    /\b(new|create|build|add)\s+(page|homepage|home\s*page|landing|feature|component|section)/i.test(
      desc,
    ) ||
    /\bhomepage\b|\bhome\s*page\b|\becommerce\b/i.test(desc)
  );
}

export function suggestNewFilePaths(knowledge, jiraTask) {
  const paths = new Set(knowledge?.suggested_new_file_paths || []);
  const desc = `${jiraTask?.summary || ""} ${jiraTask?.description || ""}`.toLowerCase();

  for (const mod of (knowledge?.relevant_modules || []).slice(0, 5)) {
    const base = String(mod).replace(/^src\//, "").replace(/\/$/, "");
    if (!base) continue;
    paths.add(`src/${base}/index.js`);
    paths.add(`src/${base}/index.jsx`);
  }

  if (/homepage|home page|landing|ecommerce/.test(desc)) {
    paths.add("src/components/Homepage/index.js");
    paths.add("src/components/Homepage/Homepage.js");
    paths.add("src/pages/index.js");
    paths.add("src/app/page.js");
  }

  for (const p of knowledge?.edit_targets || []) {
    if (p?.path && !p.exists) paths.add(normalizeRelPath(p.path));
  }

  return [...paths].filter((p) => p && !fileExistsInRepo(p)).slice(0, 8);
}
