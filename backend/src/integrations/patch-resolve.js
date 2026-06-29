export function unescapeModelString(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"');
}

export function stripWrapperQuotes(value) {
  const text = String(value ?? "").trim();
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/** Lines from source that contain task phrases — model must pick search from these */
export function findVerbatimAnchors(content, phrases = []) {
  if (!content) return [];

  const lines = content.split("\n");
  const anchors = [];
  const seen = new Set();

  for (const phrase of phrases) {
    const needle = String(phrase || "").trim();
    if (needle.length < 3) continue;

    for (const line of lines) {
      if (!line.includes(needle)) continue;
      const key = line.trim();
      if (seen.has(key)) break;
      seen.add(key);
      anchors.push(line);
      break;
    }
  }

  return anchors.slice(0, 10);
}

/**
 * Resolve model search/replace to verbatim substrings that exist in the file.
 * Handles common LLM mistakes: inner text only, wrong quote wrapper, escaped newlines.
 */
export function resolveSearchBlock(original, rawSearch, rawReplace) {
  const search = unescapeModelString(rawSearch ?? "");
  const replace = unescapeModelString(rawReplace ?? "");

  if (!search) return null;

  if (original.includes(search)) {
    return { search, replace, strategy: "exact" };
  }

  const needle = stripWrapperQuotes(search).trim();
  const replacementInner = stripWrapperQuotes(replace).trim();

  if (!needle) return null;

  const jsxLiteralPairs = [
    [`{'${needle}'}`, `{'${replacementInner}'}`],
    [`{"${needle}"}`, `{"${replacementInner}"}`],
    [`{\`${needle}\`}`, `{\`${replacementInner}\`}`],
  ];

  for (const [pat, repl] of jsxLiteralPairs) {
    if (!original.includes(pat)) continue;
    const count = original.split(pat).length - 1;
    if (count === 1) {
      return { search: pat, replace: repl, strategy: "jsx-literal" };
    }
  }

  const matchingLines = original
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes(needle));

  if (matchingLines.length === 1) {
    const { line } = matchingLines[0];
    let newLine = line;

    if (line.includes(`{'${needle}'}`)) {
      newLine = line.replace(`{'${needle}'}`, `{'${replacementInner}'}`);
    } else if (line.includes(`{"${needle}"}`)) {
      newLine = line.replace(`{"${needle}"}`, `{"${replacementInner}"}`);
    } else if (line.includes(needle)) {
      newLine = line.replace(needle, replacementInner);
    }

    if (newLine !== line) {
      return { search: line, replace: newLine, strategy: "line-expand" };
    }
  }

  // Whitespace-normalized single-line fallback
  const normalizedNeedle = needle.replace(/\s+/g, " ");
  if (normalizedNeedle.length >= 8) {
    const normalizedLines = original
      .split("\n")
      .map((line, index) => ({ line, index, norm: line.replace(/\s+/g, " ").trim() }))
      .filter(({ norm }) => norm.includes(normalizedNeedle));

    if (normalizedLines.length === 1) {
      const { line } = normalizedLines[0];
      let newLine = line;

      for (const [pat, repl] of jsxLiteralPairs) {
        if (line.includes(pat)) {
          newLine = line.replace(pat, repl);
          break;
        }
      }

      if (newLine === line && line.includes(needle)) {
        newLine = line.replace(needle, replacementInner);
      }

      if (newLine !== line) {
        return { search: line, replace: newLine, strategy: "normalized-line" };
      }
    }
  }

  // Trimmed single-line match
  const trimmedSearch = search.trim();
  if (trimmedSearch && trimmedSearch !== search) {
    const trimmedResolved = resolveSearchBlock(original, trimmedSearch, replace);
    if (trimmedResolved) return { ...trimmedResolved, strategy: "trimmed-exact" };
  }

  // First line of multiline search only
  const firstLine = search.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (firstLine && firstLine.length >= 4 && search.includes("\n")) {
    const lineMatches = original
      .split("\n")
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.trim() === firstLine || line.includes(firstLine));

    if (lineMatches.length === 1) {
      const { line } = lineMatches[0];
      const inner = stripWrapperQuotes(replace).trim();
      let newLine = line;
      if (line.includes(firstLine)) {
        newLine = line.replace(firstLine, inner || replace.trim());
      }
      if (newLine !== line) {
        return { search: line, replace: newLine, strategy: "first-line" };
      }
    }
  }

  return null;
}

export function editAlreadyApplied(original, rawSearch, rawReplace) {
  const replace = unescapeModelString(rawReplace ?? "");
  const replacementInner = stripWrapperQuotes(replace).trim();
  if (!replacementInner) return false;

  const needle = stripWrapperQuotes(unescapeModelString(rawSearch ?? "")).trim();
  if (needle && original.includes(needle)) return false;

  return original.includes(replacementInner);
}
