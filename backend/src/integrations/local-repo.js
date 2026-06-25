import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import {
  getEffectiveRepoPath,
  isRepoWriteEnabled,
  getCombinedRepoStatus,
} from "./repo-target.js";
import { captureFileSnapshot } from "./repo-revert.js";
import { normalizeUiArea } from "./repo-task-intent.js";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
  "vendor",
  "__pycache__",
]);

const STOP_WORDS = new Set([
  "section",
  "update",
  "text",
  "replace",
  "string",
  "existing",
  "specifically",
  "personalize",
  "branding",
  "change",
  "target",
  "acceptance",
  "criteria",
  "correctly",
  "rendered",
  "layout",
  "distortion",
  "overflow",
  "designated",
  "styling",
  "matches",
  "original",
  "design",
  "requirements",
  "successfully",
  "removed",
  "social",
  "media",
  "content",
  "personalized",
  "minimal",
  "localized",
  "single",
  "task",
  "what",
  "with",
  "from",
  "that",
  "this",
  "will",
  "must",
  "should",
  "does",
  "cause",
  "place",
  "into",
  "their",
  "doesn",
]);

const TASK_AREA_HINTS = [
  "footer",
  "header",
  "navbar",
  "sidebar",
  "cart",
  "checkout",
  "modal",
  "banner",
  "hero",
  "coupon",
  "login",
  "home",
];

const KEY_FILES = [
  "package.json",
  "README.md",
  "readme.md",
  "tsconfig.json",
  "vite.config.js",
  "vite.config.ts",
  "next.config.js",
  "next.config.mjs",
  "tailwind.config.js",
  "docs/architecture.md",
];

export function isTargetRepoConfigured() {
  return Boolean(getEffectiveRepoPath());
}

export function getTargetRepoPath() {
  return getEffectiveRepoPath();
}

function assertInsideRepo(relPath) {
  const root = getTargetRepoPath();
  const full = path.resolve(root, relPath);
  if (!full.startsWith(root + path.sep) && full !== root) {
    throw new Error(`Unsafe path outside target repo: ${relPath}`);
  }
  return full;
}

export function getRepoStatus() {
  return getCombinedRepoStatus();
}

function readPackageJson(repoPath = getTargetRepoPath()) {
  try {
    const raw = fs.readFileSync(path.join(repoPath, "package.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function detectStack(pkg) {
  if (!pkg) return ["unknown"];
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const stack = [];
  if (deps.next) stack.push("next.js");
  if (deps.react) stack.push("react");
  if (deps.express) stack.push("express");
  if (deps.vite) stack.push("vite");
  if (deps["@playwright/test"] || deps.playwright) stack.push("playwright");
  if (deps.tailwindcss) stack.push("tailwindcss");
  return stack.length ? stack : ["node.js"];
}

function walkRepo(dir, prefix = "", depth = 0, maxDepth = 3, results = []) {
  if (depth > maxDepth || results.length > 400) return results;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;

    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push({ path: rel + "/", type: "dir" });
      walkRepo(path.join(dir, entry.name), rel, depth + 1, maxDepth, results);
    } else {
      results.push({ path: rel, type: "file", size: fs.statSync(path.join(dir, entry.name)).size });
    }
  }

  return results;
}

function readFileSafe(relPath, maxChars = 8000) {
  try {
    const full = assertInsideRepo(relPath);
    if (!fs.existsSync(full) || fs.statSync(full).size > 200_000) return null;
    return fs.readFileSync(full, "utf-8").slice(0, maxChars);
  } catch {
    return null;
  }
}

function keywordTokens(text) {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
    .slice(0, 12);
}

function extractAreaTokens(text) {
  const lower = (text || "").toLowerCase();
  return TASK_AREA_HINTS.filter((hint) => lower.includes(hint));
}

function pathMatchesArea(relPath, areaTokens) {
  if (!areaTokens.length) return true;
  const lower = relPath.toLowerCase();
  return areaTokens.some((t) => lower.includes(t));
}

function isHeaderArea(intent) {
  return normalizeUiArea(intent?.ui_area) === "site_header";
}

function isFooterArea(intent) {
  return normalizeUiArea(intent?.ui_area) === "site_footer";
}

function pathBlockedByIntent(relPath, intent) {
  if (!intent) return false;
  const lower = relPath.toLowerCase();
  for (const ex of intent.exclude_path_hints || []) {
    if (ex && lower.includes(String(ex).toLowerCase())) return true;
  }
  if (isFooterArea(intent) && /newheader|\/header\//.test(lower) && !/footer/.test(lower)) {
    return true;
  }
  if (isHeaderArea(intent) && /footerlinks|newfooter|\/footer\//.test(lower) && !/header/.test(lower)) {
    return true;
  }
  return false;
}

function scorePathByIntent(relPath, intent) {
  if (!intent || pathBlockedByIntent(relPath, intent)) return -1;

  const lower = relPath.toLowerCase();
  let score = 0;

  for (const hint of intent.include_path_hints || []) {
    const h = String(hint).toLowerCase();
    const segments = lower.split("/");
    if (segments.some((seg) => seg === h || seg.includes(h))) score += 5;
    const base = path.basename(relPath, path.extname(relPath)).toLowerCase();
    if (base === h) score += 8;
  }

  const parts = lower.split("/");
  const baseName = path.basename(relPath, path.extname(relPath)).toLowerCase();
  const parentDir = parts[parts.length - 2];
  const pathRelevant =
    (intent.include_path_hints || []).some((h) => lower.includes(String(h).toLowerCase())) ||
    (isHeaderArea(intent) && /header/.test(lower)) ||
    (isFooterArea(intent) && /footer/.test(lower));
  if (parentDir && baseName === parentDir && pathRelevant) score += 10;
  if (parts.length > 5) score -= (parts.length - 5) * 2;

  if (isHeaderArea(intent)) {
    if (/newheader\/newheader\.(js|jsx|tsx)$/.test(lower)) score += 15;
    if (/common\/header\/header\.(js|jsx|tsx)$/.test(lower)) score += 4;
    if (/^src\/components\//.test(lower)) score -= 10;
    if (/\/algolia\/|skeleton|cart|checkout|seoheader|styled/.test(lower)) score -= 12;
  } else if (isFooterArea(intent)) {
    if (/footerlinks|newfooter|common\/footer/.test(lower)) score += 6;
    if (/cart|checkout|email/.test(lower)) score -= 8;
  }

  if (/\.(js|jsx|ts|tsx|vue)$/.test(lower)) score += 1;
  return score;
}

function findRelevantFilesByIntent(repoPath, intent) {
  if (!intent) return [];

  const hints = [
    ...(intent.include_path_hints || []),
    ...(intent.relevant_module_hints || []),
  ].filter(Boolean);

  const hits = [];
  const seen = new Set();

  function shouldFollowDir(rel, depth) {
    const lower = rel.toLowerCase().replace(/\/$/, "");
    const name = lower.split("/").pop();

    if (depth === 0) {
      return ["components", "src", "app", "pages", "lib"].includes(name);
    }
    if (hints.some((h) => lower.includes(String(h).toLowerCase()))) return true;
    if (isHeaderArea(intent) && /header/.test(lower)) return true;
    if (isFooterArea(intent) && /footer/.test(lower)) return true;
    if (/^components\/[^/]+$/.test(lower)) return true;
    return false;
  }

  function walk(dir, prefix = "", depth = 0) {
    if (depth > 6 || hits.length >= 16) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;

      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (shouldFollowDir(rel, depth)) walk(full, rel, depth + 1);
        continue;
      }

      if (!/\.(js|jsx|ts|tsx|vue)$/i.test(entry.name)) continue;

      const score = scorePathByIntent(rel, intent);
      if (score < 3 || seen.has(rel)) continue;

      seen.add(rel);
      hits.push({
        path: rel,
        snippet: readFileSafe(rel, 1500),
        match_type: "intent",
        score,
      });
    }
  }

  walk(repoPath);
  return hits.sort((a, b) => b.score - a.score).slice(0, 6);
}

function findRelevantFiles(task, tree, extraText = "", intent = null) {
  const tokens = keywordTokens(`${task.summary} ${task.description} ${extraText}`);
  const areaTokens = extractAreaTokens(`${task.summary} ${task.description} ${extraText}`);
  const files = tree.filter((e) => e.type === "file");
  const scored = files
    .map((f) => {
      if (pathBlockedByIntent(f.path, intent)) return { ...f, score: -1 };

      const lower = f.path.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (lower.includes(t)) score += 2;
      }
      for (const area of areaTokens) {
        if (lower.includes(area)) score += 3;
      }
      if (/\.(js|jsx|ts|tsx|vue)$/.test(lower)) score += 1;
      return { ...f, score };
    })
    .filter((f) => f.score >= 4 && pathMatchesArea(f.path, areaTokens))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  return scored.map((f) => ({
    path: f.path,
    snippet: readFileSafe(f.path, 1500),
    match_type: "keyword",
  }));
}

function dirsFromMatches(matches, intent) {
  const dirs = new Set(intent?.relevant_module_hints || []);
  for (const m of matches) {
    const parts = m.path.split("/");
    if (parts.length > 1) dirs.add(parts.slice(0, -1).join("/"));
  }
  return [...dirs].slice(0, 12);
}

/** Find files whose contents contain a literal phrase (for retry / user hints). */
function findFilesByContentPhrase(repoPath, phrase, maxResults = 12) {
  if (!phrase || phrase.length < 4) return [];

  const needle = phrase.toLowerCase();
  const hits = [];

  function walk(dir, prefix = "", depth = 0) {
    if (depth > 5 || hits.length >= maxResults) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full, rel, depth + 1);
        continue;
      }

      if (!/\.(js|jsx|ts|tsx|vue|json|html|md|css|scss)$/i.test(entry.name)) continue;

      try {
        const stat = fs.statSync(full);
        if (stat.size > 200_000) continue;
        const content = fs.readFileSync(full, "utf-8");
        if (content.toLowerCase().includes(needle)) {
          const idx = content.toLowerCase().indexOf(needle);
          const snippet = content.slice(Math.max(0, idx - 80), idx + needle.length + 80);
          hits.push({ path: rel, snippet, match_type: "content" });
        }
      } catch {
        // skip unreadable
      }
    }
  }

  walk(repoPath);
  return hits;
}

function extractSearchPhrases(extraText) {
  if (!extraText) return [];

  const quoted = [...extraText.matchAll(/"([^"]{4,})"|'([^']{4,})'/g)].map((m) => m[1] || m[2]);

  const replaceMatch = extraText.match(
    /replace[^"']*["']([^"']{4,})["'][^"']*with[^"']*["']([^"']+)["']/i,
  );
  if (replaceMatch) {
    const source = replaceMatch[1];
    const rest = quoted.filter((q) => q !== replaceMatch[2]);
    return [source, ...rest.filter((q) => q !== source)];
  }

  return [...new Set(quoted)].sort((a, b) => b.length - a.length);
}

function searchContentPhrases(repoPath, phrases, maxResults = 8) {
  const hits = [];
  const seen = new Set();

  for (const phrase of phrases) {
    if (!phrase || phrase.length < 6) continue;

    for (const hit of findFilesByContentPhrase(repoPath, phrase, maxResults)) {
      if (seen.has(hit.path)) continue;
      seen.add(hit.path);
      hits.push({ ...hit, search_phrase: phrase });
    }

    // Stop after the first phrase that finds real hits (usually the string being replaced)
    if (hits.length > 0) break;
  }

  return hits;
}

export function gatherKnowledgeContext(jiraTask, retryFeedback = "", intent = null) {
  const repoPath = getTargetRepoPath();
  if (!repoPath || !fs.existsSync(repoPath)) {
    const status = getCombinedRepoStatus();
    return {
      summary: "No codebase connected — using generic planning context",
      repo_connected: false,
      relevant_modules: ["src/components", "src/api"],
      constraints: ["Connect GITLAB_* or TARGET_REPO_PATH in backend/.env"],
      dependencies: [],
      risks: [],
      documentation_refs: [],
      codebase_notes: status.message || "No repo configured",
    };
  }

  const pkg = readPackageJson(repoPath);
  const stack = detectStack(pkg);
  const tree = walkRepo(repoPath);
  const intentMatches = findRelevantFilesByIntent(repoPath, intent);
  const matched = findRelevantFiles(jiraTask, tree, retryFeedback, intent);
  const areaTokens = extractAreaTokens(
    `${jiraTask.summary} ${jiraTask.description} ${retryFeedback}`,
  );

  const phrases = [
    ...(intent?.content_search_phrases || []),
    ...extractSearchPhrases(jiraTask.description || ""),
    ...extractSearchPhrases(jiraTask.summary || ""),
    ...extractSearchPhrases(retryFeedback),
  ];

  const contentMatches = searchContentPhrases(repoPath, [...new Set(phrases)]).filter(
    (m) => !pathBlockedByIntent(m.path, intent),
  );

  const seen = new Set(contentMatches.map((m) => m.path));
  const intentAdds = intentMatches.filter((m) => !seen.has(m.path));
  intentAdds.forEach((m) => seen.add(m.path));

  const keywordAdds = matched.filter((m) => {
    if (seen.has(m.path)) return false;
    if (pathBlockedByIntent(m.path, intent)) return false;
    if (contentMatches.length > 0 || intentAdds.length > 0) {
      return pathMatchesArea(m.path, areaTokens);
    }
    return true;
  });

  const mergedMatches = [...contentMatches, ...intentAdds, ...keywordAdds].slice(0, 8);
  const keyFileContents = {};

  for (const name of KEY_FILES) {
    const content = readFileSafe(name, 4000);
    if (content) keyFileContents[name] = content;
  }

  const moduleDirs = dirsFromMatches(mergedMatches, intent);
  const srcDirs = tree
    .filter((e) => e.type === "dir" && /^src\/|app\/|pages\/|components\//.test(e.path))
    .map((e) => e.path)
    .slice(0, 15);

  const intentNote = intent?.intent_summary
    ? ` Intent: ${intent.intent_summary.slice(0, 120)}.`
    : "";

  return {
    summary: `Codebase: ${pkg?.name || path.basename(repoPath)} (${stack.join(", ")})`,
    repo_connected: true,
    repo_path: repoPath,
    project_name: pkg?.name || path.basename(repoPath),
    stack,
    task_intent: intent || null,
    relevant_modules: moduleDirs.length
      ? moduleDirs
      : srcDirs.length
        ? srcDirs
        : tree.filter((e) => e.type === "dir").map((e) => e.path).slice(0, 10),
    matched_files: mergedMatches,
    key_files: Object.keys(keyFileContents),
    package_scripts: pkg?.scripts ? Object.keys(pkg.scripts) : [],
    constraints: [
      "Follow existing project structure and naming conventions",
      `Stack: ${stack.join(", ")}`,
      "Reuse existing patterns found in matched files",
    ],
    dependencies: stack,
    risks: ["Generated files must align with existing module boundaries"],
    documentation_refs: Object.keys(keyFileContents).filter((k) => k.toLowerCase().includes("readme") || k.includes("architecture")),
    codebase_notes: retryFeedback
      ? `Indexed ${tree.length} paths. ${mergedMatches.length} files matched (intent + content + retry).${intentNote}`
      : `Indexed ${tree.length} paths. ${mergedMatches.length} files matched (intent-guided search).${intentNote}`,
    file_tree_sample: tree.slice(0, 40),
  };
}

export function getRepoPromptContext(knowledge) {
  if (!knowledge?.repo_connected) return "";

  return `Local project codebase:
Path: ${knowledge.repo_path}
Stack: ${(knowledge.stack || []).join(", ")}
Relevant modules: ${JSON.stringify(knowledge.relevant_modules || [])}
Matched files: ${JSON.stringify((knowledge.matched_files || []).map((f) => f.path))}
Package scripts: ${JSON.stringify(knowledge.package_scripts || [])}
File tree sample: ${JSON.stringify(knowledge.file_tree_sample || [])}
`;
}

export function writeFilesToTargetRepo(files, snapshotMap = {}) {
  if (!isTargetRepoConfigured()) {
    return { written: [], skipped: true, reason: "TARGET_REPO_PATH not configured" };
  }
  if (!isRepoWriteEnabled()) {
    return { written: [], skipped: true, reason: "TARGET_REPO_WRITE is false" };
  }

  const root = getTargetRepoPath();
  const snapshots = { ...snapshotMap };
  const written = [];

  for (const file of files || []) {
    if (!file?.path) continue;
    if (!snapshots[file.path]) {
      snapshots[file.path] = captureFileSnapshot(file.path);
    }

    const fullPath = assertInsideRepo(file.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content, "utf-8");
    written.push(file.path);
  }

  return { root, written, snapshot_map: snapshots, skipped: false };
}

export function runRepoLint() {
  const repoPath = getTargetRepoPath();
  if (!repoPath || !fs.existsSync(repoPath)) return null;

  const pkg = readPackageJson();
  if (!pkg?.scripts?.lint) {
    return { ran: false, message: "No npm run lint script in target repo" };
  }

  try {
    const output = execSync("npm run lint", {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ran: true, passed: true, output: output.slice(0, 3000) };
  } catch (err) {
    return {
      ran: true,
      passed: false,
      output: `${err.stdout || ""}\n${err.stderr || ""}`.slice(0, 3000),
    };
  }
}
