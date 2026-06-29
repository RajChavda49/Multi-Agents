import { findVerbatimAnchors } from "./patch-resolve.js";

export function addLineNumbers(content, startLine = 1) {
  if (!content) return "";
  return content
    .split("\n")
    .map((line, i) => `${String(startLine + i).padStart(4, " ")}| ${line}`)
    .join("\n");
}

export function extractNearbyLines(content, needle, contextLines = 8) {
  if (!content || !needle) return [];
  const lines = content.split("\n");
  const trimmed = String(needle).trim();
  const firstLine = trimmed.split("\n")[0].trim();

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(firstLine) || (firstLine.length >= 6 && lines[i].trim().includes(firstLine))) {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length, i + contextLines + 1);
      return lines.slice(start, end).map((line, j) => ({
        line_no: start + j + 1,
        text: line,
      }));
    }
  }
  return [];
}

export function buildPatchFailureContext(relPath, original, rawSearch, searchPhrases = []) {
  const anchors = findVerbatimAnchors(original, searchPhrases);
  const nearby = extractNearbyLines(original, rawSearch);
  const numbered = addLineNumbers(original);

  return {
    path: relPath,
    file_length: original.length,
    line_count: original.split("\n").length,
    verbatim_anchors: anchors,
    nearby_lines: nearby,
    numbered_source: numbered.length > 12000 ? numbered.slice(0, 12000) + "\n/* …truncated … */" : numbered,
    failed_search_preview: String(rawSearch || "").slice(0, 200),
    recovery_hint:
      anchors.length > 0
        ? `Use ONE of verbatim_anchors as the full "search" line (copy character-for-character).`
        : `Pick ONE complete line from numbered_source (include leading spaces). Do not invent text.`,
  };
}

export class PatchApplyError extends Error {
  constructor(message, patchFailure) {
    super(message);
    this.name = "PatchApplyError";
    this.patchFailure = patchFailure;
  }
}
