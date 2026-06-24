import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import {
  getEffectiveRepoPath,
  isRepoWriteEnabled,
  getCombinedRepoStatus,
} from "./repo-target.js";
import { captureFileSnapshot } from "./repo-revert.js";

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
    .filter((w) => w.length > 3)
    .slice(0, 12);
}

function findRelevantFiles(task, tree, extraText = "") {
  const tokens = keywordTokens(`${task.summary} ${task.description} ${extraText}`);
  const files = tree.filter((e) => e.type === "file");
  const scored = files
    .map((f) => {
      const lower = f.path.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (lower.includes(t)) score += 2;
      }
      if (/\.(js|jsx|ts|tsx|vue)$/.test(lower)) score += 1;
      if (lower.includes("component") || lower.includes("page") || lower.includes("api")) score += 1;
      return { ...f, score };
    })
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  return scored.map((f) => ({
    path: f.path,
    snippet: readFileSafe(f.path, 1500),
  }));
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
  if (quoted.length) return quoted;
  if (extraText.length >= 8) return [extraText.slice(0, 120)];
  return [];
}

export function gatherKnowledgeContext(jiraTask, retryFeedback = "") {
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
  const matched = findRelevantFiles(jiraTask, tree, retryFeedback);

  const contentMatches = [];
  const phrases = [
    ...extractSearchPhrases(jiraTask.description || ""),
    ...extractSearchPhrases(jiraTask.summary || ""),
    ...extractSearchPhrases(retryFeedback),
  ];
  for (const phrase of phrases) {
    for (const hit of findFilesByContentPhrase(repoPath, phrase)) {
      if (!contentMatches.some((h) => h.path === hit.path)) {
        contentMatches.push(hit);
      }
    }
  }

  const mergedMatches = [
    ...contentMatches,
    ...matched.filter((m) => !contentMatches.some((c) => c.path === m.path)),
  ].slice(0, 12);
  const keyFileContents = {};

  for (const name of KEY_FILES) {
    const content = readFileSafe(name, 4000);
    if (content) keyFileContents[name] = content;
  }

  const srcDirs = tree
    .filter((e) => e.type === "dir" && /^src\/|app\/|pages\/|components\//.test(e.path))
    .map((e) => e.path)
    .slice(0, 15);

  return {
    summary: `Codebase: ${pkg?.name || path.basename(repoPath)} (${stack.join(", ")})`,
    repo_connected: true,
    repo_path: repoPath,
    project_name: pkg?.name || path.basename(repoPath),
    stack,
    relevant_modules: srcDirs.length ? srcDirs : tree.filter((e) => e.type === "dir").map((e) => e.path).slice(0, 10),
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
      ? `Indexed ${tree.length} paths. ${mergedMatches.length} files matched (incl. content search from retry feedback).`
      : `Indexed ${tree.length} paths from ${repoPath}. ${matched.length} files matched Jira task keywords.`,
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
  if (!isTargetRepoConfigured() || !isRepoWriteEnabled()) {
    return { written: [], skipped: true, reason: "repo write disabled or not configured" };
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
