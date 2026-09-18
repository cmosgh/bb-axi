import { bool, expectPositionals, flags, parseArgs, positiveId } from "../args.js";
import { bbPaginate, bbText } from "../client.js";
import { repoHint, type RepoContext } from "../context.js";
import { matchesPath, selectDiff } from "../diff.js";
import { prPath } from "../pr-api.js";
import { block, dig, helpBlock, num, obj, out, str } from "../render.js";

/** ~8-10k tokens: enough for most PRs in one call without flooding context. */
const DIFF_BUDGET_CHARS = 32_000;
const MAX_FILE_ROWS = 300;

interface FileStat {
  path: string;
  status: string;
  added: number;
  removed: number;
}

function toFileStat(entry: unknown): FileStat {
  const e = obj(entry);
  const newPath = str(dig(e, "new", "path"));
  const oldPath = str(dig(e, "old", "path"));
  return {
    path: newPath || oldPath || "(unknown)",
    status: str(e["status"]) || "modified",
    added: num(e["lines_added"]) ?? 0,
    removed: num(e["lines_removed"]) ?? 0,
  };
}

export async function prDiff(args: string[], ctx: RepoContext): Promise<string> {
  const command = "bb-axi pr diff";
  const parsed = parseArgs(
    args,
    [
      { name: "--path", repeatable: true },
      { name: "--stat", boolean: true },
      { name: "--raw", boolean: true },
      { name: "--full", boolean: true },
    ],
    command,
  );
  const [rawId] = expectPositionals(parsed, 1, `${command} <id> [--path <file|dir|glob>] [--stat] [--raw] [--full]`);
  const id = positiveId(rawId, "pull request id");
  const paths = flags(parsed, "--path");
  const statOnly = bool(parsed, "--stat");
  const full = bool(parsed, "--full");
  const hint = repoHint(ctx);

  const [statPage, diffText] = await Promise.all([
    bbPaginate(`${prPath(ctx, id)}/diffstat`, { limit: 1000, pagelen: 500 }),
    statOnly ? Promise.resolve("") : bbText(`${prPath(ctx, id)}/diff`, { timeoutMs: 60_000 }),
  ]);

  const allStats = statPage.values.map(toFileStat);
  const stats = allStats.filter((s) => matchesPath(s.path, paths));
  const added = stats.reduce((sum, s) => sum + s.added, 0);
  const removed = stats.reduce((sum, s) => sum + s.removed, 0);

  if (stats.length === 0) {
    return out(
      block({
        pr: id,
        files:
          allStats.length === 0
            ? "0 changed files in this pull request"
            : `0 of ${allStats.length} changed files match ${paths.join(", ")}`,
      }),
      helpBlock(allStats.length > 0 ? [`Run \`bb-axi pr diff ${id} --stat${hint}\` to list changed paths`] : []),
    );
  }

  const header = block({
    pr: id,
    ...(paths.length > 0 ? { scope: paths.join(" ") } : {}),
    files_changed: paths.length > 0 ? `${stats.length} of ${allStats.length}` : stats.length,
    lines: `+${added} -${removed}`,
    files: stats.slice(0, MAX_FILE_ROWS),
  });
  const help: string[] = [];
  if (stats.length > MAX_FILE_ROWS) {
    help.push(`File table shows ${MAX_FILE_ROWS} of ${stats.length}; narrow with \`--path <dir>\``);
  }

  if (statOnly) {
    help.push(`Run \`bb-axi pr diff ${id} --path <path>${hint}\` to read one file or directory`);
    return out(header, helpBlock(help));
  }

  const selection = selectDiff(diffText, {
    paths,
    full,
    annotate: !bool(parsed, "--raw"),
    budget: DIFF_BUDGET_CHARS,
  });

  const notes: Record<string, unknown> = {};
  if (selection.elided.length > 0) notes["elided_generated"] = selection.elided;
  if (selection.overBudget.length > 0) notes["not_shown_over_budget"] = selection.overBudget;

  if (selection.elided.length > 0) {
    help.push(`Lockfiles/bundles are elided; run \`bb-axi pr diff ${id} --path <path>${hint}\` to see one`);
  }
  if (selection.overBudget.length > 0 || selection.cutFile !== undefined) {
    help.push(
      `Diff exceeds the ${DIFF_BUDGET_CHARS}-char budget; run \`bb-axi pr diff ${id} --path <path>${hint}\` per file/dir, or \`--full\` for everything`,
    );
  }
  if (!bool(parsed, "--raw")) {
    help.push(
      `Inline comment: \`bb-axi pr comment ${id} --path <path> --line <n> --body "<text>"${hint}\` (use --old-line <n> for a "-" line)`,
    );
  }

  const legend = bool(parsed, "--raw")
    ? "diff: unified"
    : 'diff: annotated - leading number is the NEW file line, except on "-" lines where it is the OLD file line';
  const body = selection.body === "" ? "(no textual diff for the selected files)" : selection.body;

  return out(
    header,
    legend,
    "---",
    body,
    "---",
    Object.keys(notes).length > 0 ? block(notes) : "",
    helpBlock(help),
  );
}
