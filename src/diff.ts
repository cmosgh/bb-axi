/**
 * Unified-diff handling for PR review.
 *
 * Inline comments need an exact (path, line) pair. Deriving line numbers from
 * hunk headers is arithmetic an LLM gets wrong, so the annotated view
 * pre-computes them: `-` lines carry the OLD file line number, every other
 * line carries the NEW file line number.
 */

export interface FileDiff {
  /** New path, or the old path for a deleted file. */
  path: string;
  oldPath: string | undefined;
  /** Raw diff text for this file, including the `diff --git` header. */
  raw: string;
}

const NOISE_PATTERNS: readonly RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)npm-shrinkwrap\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)bun\.lockb?$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)uv\.lock$/,
  /(^|\/)go\.sum$/,
  /\.min\.(js|css)$/,
  /\.map$/,
];

/** Lockfiles and generated bundles: huge diffs that are never reviewed by hand. */
export function isNoiseFile(path: string): boolean {
  return NOISE_PATTERNS.some((pattern) => pattern.test(path));
}

function stripPrefix(path: string): string {
  // `a/` and `b/` prefixes; quoted paths (spaces / unicode) keep their quotes off
  const unquoted = path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
  return unquoted.replace(/^[ab]\//, "");
}

export function splitFiles(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = diff.split("\n");
  let current: string[] = [];

  const flush = (): void => {
    while (current.length > 0 && current[current.length - 1] === "") current.pop();
    if (current.length === 0) return;
    const raw = current.join("\n");
    let oldPath: string | undefined;
    let newPath: string | undefined;
    for (const line of current) {
      if (line.startsWith("@@")) break;
      if (line.startsWith("--- ")) {
        const p = line.slice(4).trim();
        oldPath = p === "/dev/null" ? undefined : stripPrefix(p);
      } else if (line.startsWith("+++ ")) {
        const p = line.slice(4).trim();
        newPath = p === "/dev/null" ? undefined : stripPrefix(p);
      } else if (line.startsWith("rename from ")) {
        oldPath ??= line.slice("rename from ".length).trim();
      } else if (line.startsWith("rename to ")) {
        newPath ??= line.slice("rename to ".length).trim();
      }
    }
    if (newPath === undefined && oldPath === undefined) {
      // binary or mode-only change: fall back to the `diff --git a/x b/y` header
      const header = current[0]?.match(/^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/);
      oldPath = header?.[1];
      newPath = header?.[2];
    }
    files.push({
      path: newPath ?? oldPath ?? "(unknown)",
      oldPath: oldPath !== newPath ? oldPath : undefined,
      raw,
    });
    current = [];
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) flush();
    if (current.length > 0 || line.startsWith("diff --git ")) current.push(line);
  }
  flush();
  return files;
}

/**
 * Prefix every hunk line with the line number an inline comment would target.
 * Header lines (`diff --git`, `index`, `---`, `+++`) are dropped except the
 * file header itself - the path is already known and they only cost tokens.
 */
export function annotate(file: FileDiff): string {
  const output: string[] = [];
  const lines = file.raw.split("\n");
  let oldLine = 0;
  let newLine = 0;
  // Hunk headers declare how many old/new lines follow; counting them down is
  // the only reliable way to tell a blank context line from the end of a hunk.
  let oldLeft = 0;
  let newLeft = 0;
  let width = 4;

  for (const line of lines) {
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      oldLeft = Number(hunk[2] ?? 1);
      newLine = Number(hunk[3]);
      newLeft = Number(hunk[4] ?? 1);
      width = Math.max(4, String(Math.max(oldLine + oldLeft, newLine + newLeft)).length);
      output.push(line);
      continue;
    }
    if (line.startsWith("\\")) {
      output.push(line); // "\ No newline at end of file" - may trail the last hunk line
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) {
      if (
        line.startsWith("Binary files ") ||
        line.startsWith("rename ") ||
        line.startsWith("new file") ||
        line.startsWith("deleted file") ||
        line.startsWith("similarity ")
      ) {
        output.push(line);
      }
      continue;
    }
    const marker = line[0] ?? " ";
    const code = line.slice(1);
    if (marker === "-") {
      output.push(`${String(oldLine).padStart(width)} -${code}`);
      oldLine++;
      oldLeft--;
    } else if (marker === "+") {
      output.push(`${String(newLine).padStart(width)} +${code}`);
      newLine++;
      newLeft--;
    } else {
      output.push(`${String(newLine).padStart(width)}  ${code}`);
      oldLine++;
      newLine++;
      oldLeft--;
      newLeft--;
    }
  }
  return `== ${file.path}${file.oldPath ? ` (was ${file.oldPath})` : ""}\n${output.join("\n")}`;
}

export function matchesPath(path: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => {
    if (pattern.includes("*")) {
      const regex = new RegExp(
        `^${pattern
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      );
      return regex.test(path);
    }
    const dir = pattern.endsWith("/") ? pattern : `${pattern}/`;
    return path === pattern || path.startsWith(dir);
  });
}

export interface DiffSelection {
  /** Rendered text for the files that fit. */
  body: string;
  shown: string[];
  /** Skipped as noise (lockfiles, bundles); view with --path. */
  elided: string[];
  /** Did not fit in the budget; view with --path or --full. */
  overBudget: string[];
  /** A single file that alone exceeded the budget and was cut. */
  cutFile: string | undefined;
  totalChars: number;
}

export function selectDiff(
  diff: string,
  options: { paths: readonly string[]; full: boolean; annotate: boolean; budget: number },
): DiffSelection {
  const explicit = options.paths.length > 0;
  const files = splitFiles(diff).filter((file) => matchesPath(file.path, options.paths));
  const selection: DiffSelection = {
    body: "",
    shown: [],
    elided: [],
    overBudget: [],
    cutFile: undefined,
    totalChars: 0,
  };
  const parts: string[] = [];
  let used = 0;

  for (const file of files) {
    // An explicit --path (or --full) is a deliberate request: never elide it.
    if (!explicit && !options.full && isNoiseFile(file.path)) {
      selection.elided.push(file.path);
      continue;
    }
    const text = options.annotate ? annotate(file) : file.raw;
    selection.totalChars += text.length;
    if (options.full || used + text.length <= options.budget) {
      parts.push(text);
      selection.shown.push(file.path);
      used += text.length;
      continue;
    }
    if (parts.length === 0 && selection.cutFile === undefined) {
      // First file alone blows the budget: show what fits, cut on a line boundary.
      const slice = text.slice(0, options.budget);
      const lastBreak = slice.lastIndexOf("\n");
      parts.push(
        `${lastBreak > 0 ? slice.slice(0, lastBreak) : slice}\n... (truncated, ${text.length} chars total in this file)`,
      );
      selection.shown.push(file.path);
      selection.cutFile = file.path;
      used = options.budget;
      continue;
    }
    selection.overBudget.push(file.path);
  }

  selection.body = parts.join("\n");
  return selection;
}
