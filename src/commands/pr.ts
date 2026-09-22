import { bool, enumFlag, expectPositionals, flag, intFlag, parseArgs, parseFields, positiveId } from "../args.js";
import { bbPaginate } from "../client.js";
import { bbqlString, fetchPr, stateClause } from "../pr-api.js";
import { repoHint, repoPath, requireRepo, type RepoContext } from "../context.js";
import { axiError, usageError } from "../errors.js";
import { currentUser } from "../me.js";
import {
  authorName,
  branches,
  buildsSummary,
  isAuthor,
  isDraft,
  myReviewStatus,
  PR_LIST_FIELDS,
  prState,
  reviewers,
  reviewSummary,
} from "../pr-model.js";
import { block, countLine, dig, helpBlock, num, obj, out, relTime, str, truncate, type Obj } from "../render.js";
import { prApprove, prCreate, prDecline, prMerge, prRequestChanges } from "./pr-actions.js";
import { prComment, prComments, prResolve } from "./pr-comments.js";
import { prDiff } from "./pr-diff.js";

const SUBCOMMANDS = [
  "list",
  "view",
  "diff",
  "comments",
  "comment",
  "resolve",
  "unresolve",
  "approve",
  "unapprove",
  "request-changes",
  "unrequest-changes",
  "create",
  "merge",
  "decline",
] as const;

export const PR_HELP = `usage: bb-axi pr <subcommand> [args] [flags]
subcommands[14]:
  list, view <id>, diff <id>, comments <id>, comment <id>, resolve <id> <comment-id>, unresolve <id> <comment-id>, approve <id>, unapprove <id>, request-changes <id>, unrequest-changes <id>, create, merge <id>, decline <id>
flags{list}:
  --state <open|merged|declined|superseded|all> (default open), --mine (authored by you), --reviewing (you are a reviewer), --source <branch>, --dest <branch>, --query <BBQL>, --limit <1-200> (default 50), --fields <state,updated,created,source,dest,comments,tasks,url>
flags{view}:
  --full (untruncated description)
flags{diff}:
  --path <file|dir|glob> (repeatable), --stat (file table only), --raw (no line-number annotation), --full (no budget, include lockfiles)
flags{comments}:
  --unresolved (open threads only), --path <file|dir|glob> (repeatable), --limit <1-500> (default 100), --full (untruncated bodies)
flags{comment}:
  --body <text> | --body-file <path|->, --path <file> with --line <new-line> or --old-line <old-line>, --reply-to <comment-id>, --pending (draft, visible only to you until published), --allow-duplicate
flags{resolve,unresolve}:
  none; any comment id in the thread works (the root is resolved)
flags{create}:
  --title <text> (required), --source <branch> (default current branch), --dest <branch> (default repo main branch), --body <text> | --body-file <path|->, --reviewer <uuid|display name> (repeatable), --default-reviewers, --draft, --close-source
flags{merge}:
  --confirm (required to merge; without it prints a preview), --strategy <merge_commit|squash|fast_forward>, --message <text>, --close-source
flags{decline}:
  --confirm (required to decline; without it prints a preview)
global:
  -R/--repo <workspace>/<repo> (default: bitbucket.org remote of the current checkout)
examples[5]:
  bb-axi pr list --reviewing
  bb-axi pr view 42
  bb-axi pr diff 42 --path src/app/
  bb-axi pr comment 42 --path src/app/a.ts --line 17 --body "Guard the null case here" --pending
  bb-axi pr approve 42
`;

export async function prCommand(args: string[], ctx?: RepoContext): Promise<string> {
  const [sub, ...rest] = args;
  if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw usageError(sub ? `unknown pr subcommand '${sub}'` : "missing pr subcommand", [
      `subcommands: ${SUBCOMMANDS.join(", ")}`,
      "Run `bb-axi pr --help` for flags",
    ]);
  }
  const repo = requireRepo(ctx);
  switch (sub) {
    case "list":
      return prList(rest, repo);
    case "view":
      return prView(rest, repo);
    case "diff":
      return prDiff(rest, repo);
    case "comments":
      return prComments(rest, repo);
    case "comment":
      return prComment(rest, repo);
    case "resolve":
      return prResolve(rest, repo, true);
    case "unresolve":
      return prResolve(rest, repo, false);
    case "approve":
      return prApprove(rest, repo, true);
    case "unapprove":
      return prApprove(rest, repo, false);
    case "request-changes":
      return prRequestChanges(rest, repo, true);
    case "unrequest-changes":
      return prRequestChanges(rest, repo, false);
    case "create":
      return prCreate(rest, repo);
    case "merge":
      return prMerge(rest, repo);
    default:
      return prDecline(rest, repo);
  }
}

const LIST_EXTRA_FIELDS = ["state", "updated", "created", "source", "dest", "comments", "tasks", "url"] as const;
const STATES = ["open", "merged", "declined", "superseded", "all"] as const;

export function listRow(pr: unknown, extras: readonly string[], me: Awaited<ReturnType<typeof currentUser>>): Obj {
  const row: Obj = {
    id: num(obj(pr)["id"]) ?? null,
    title: str(obj(pr)["title"]),
    author: authorName(pr),
    review: reviewSummary(pr, me),
  };
  const b = branches(pr);
  for (const extra of extras) {
    if (extra === "state") row["state"] = prState(pr);
    else if (extra === "updated") row["updated"] = relTime(obj(pr)["updated_on"]);
    else if (extra === "created") row["created"] = relTime(obj(pr)["created_on"]);
    else if (extra === "source") row["source"] = b.source;
    else if (extra === "dest") row["dest"] = b.dest;
    else if (extra === "comments") row["comments"] = num(obj(pr)["comment_count"]) ?? 0;
    else if (extra === "tasks") row["tasks"] = num(obj(pr)["task_count"]) ?? 0;
    else if (extra === "url") row["url"] = str(dig(pr, "links", "html", "href"));
  }
  return row;
}

async function prList(args: string[], ctx: RepoContext): Promise<string> {
  const command = "bb-axi pr list";
  const parsed = parseArgs(
    args,
    [
      { name: "--state" },
      { name: "--mine", boolean: true },
      { name: "--reviewing", boolean: true },
      { name: "--source" },
      { name: "--dest" },
      { name: "--query" },
      { name: "--limit" },
      { name: "--fields" },
    ],
    command,
  );
  expectPositionals(parsed, 0, `${command} [flags]`);
  const state = enumFlag(parsed, "--state", STATES, "open");
  const limit = intFlag(parsed, "--limit", 50, { min: 1, max: 200 });
  const extras = parseFields(flag(parsed, "--fields"), LIST_EXTRA_FIELDS);

  const me = await currentUser();
  const clauses: string[] = [];
  // The endpoint defaults to OPEN only, so the state is always sent as the
  // documented (repeatable) `state` parameter. It is ALSO folded into BBQL
  // below whenever a `q` is sent, because Bitbucket silently ignores `state`
  // in that case - `--state declined --query ...` would otherwise return
  // every state. Sending both keeps the two forms in agreement.
  const states = state === "all" ? ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"] : [state.toUpperCase()];
  if (bool(parsed, "--mine") || bool(parsed, "--reviewing")) {
    if (!me) {
      throw axiError("--mine/--reviewing need a user identity", "AUTH_REQUIRED", [
        "Authenticate with an account API token (`bb-axi auth login`); access tokens are not tied to a user",
      ]);
    }
    if (bool(parsed, "--mine")) clauses.push(`author.uuid=${bbqlString(me.uuid)}`);
    if (bool(parsed, "--reviewing")) clauses.push(`reviewers.uuid=${bbqlString(me.uuid)}`);
  }
  const source = flag(parsed, "--source");
  if (source) clauses.push(`source.branch.name=${bbqlString(source)}`);
  const dest = flag(parsed, "--dest");
  if (dest) clauses.push(`destination.branch.name=${bbqlString(dest)}`);
  const rawQuery = flag(parsed, "--query");
  if (rawQuery) clauses.push(`(${rawQuery})`);
  if (clauses.length > 0) clauses.unshift(stateClause(states));

  const page = await bbPaginate(`${repoPath(ctx)}/pullrequests`, {
    query: {
      state: states,
      q: clauses.length > 0 ? clauses.join(" AND ") : undefined,
      sort: "-updated_on",
      fields: PR_LIST_FIELDS,
    },
    limit,
    pagelen: 50,
  });

  // No commas: a comma would force TOON to quote the whole empty-state line.
  const label = [
    state === "all" ? "" : state,
    "pull requests",
    bool(parsed, "--mine") ? "authored by you" : "",
    bool(parsed, "--reviewing") ? "awaiting your review" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const hint = repoHint(ctx);

  if (page.values.length === 0) {
    return out(
      block({ prs: `0 ${label} in ${ctx.slug}` }),
      helpBlock(
        state === "open" && !rawQuery
          ? [
              `Run \`bb-axi pr list --state all${hint}\` to include merged and declined`,
              `Run \`bb-axi pr create --title "<title>" --source <branch>${hint}\` to open one`,
            ]
          : [`Run \`bb-axi pr list${hint}\` for open pull requests`],
      ),
    );
  }

  const rows = page.values.map((pr) => listRow(pr, extras, me));
  const help = [`Run \`bb-axi pr view <id>${hint}\` for reviewers, builds and description`];
  if (page.more) {
    help.push(
      `Showing ${rows.length} of ${page.size ?? "more"} - raise \`--limit\` (max 200) or narrow with --mine / --reviewing / --source / --dest`,
    );
  }
  return out(
    block({ count: countLine(rows.length, page.size, page.more), prs: rows }),
    helpBlock(help),
  );
}

async function prView(args: string[], ctx: RepoContext): Promise<string> {
  const command = "bb-axi pr view";
  const parsed = parseArgs(args, [{ name: "--full", boolean: true }], command);
  const [rawId] = expectPositionals(parsed, 1, `${command} <id> [--full]`);
  const id = positiveId(rawId, "pull request id");

  const [pr, statuses, me] = await Promise.all([
    fetchPr(ctx, id),
    // Build status is a convenience aggregate; its failure must not hide the PR.
    bbPaginate(`${repoPath(ctx)}/pullrequests/${id}/statuses`, { limit: 50, pagelen: 50 })
      .then((page) => page.values)
      .catch(() => undefined),
    currentUser(),
  ]);

  const b = branches(pr);
  const description = str(pr["description"]) || str(dig(pr, "summary", "raw"));
  const body = bool(parsed, "--full")
    ? { text: description, truncated: false, total: description.length }
    : truncate(description, 1000);
  const reviewerRows = reviewers(pr).map((r) => ({
    name: me && r.uuid === me.uuid ? `${r.name} (you)` : r.name,
    status: r.status,
  }));
  const state = prState(pr);
  const hint = repoHint(ctx);

  const detail: Obj = {
    id,
    title: str(pr["title"]),
    state: isDraft(pr) ? `${state} (draft)` : state,
    author: isAuthor(pr, me) ? `${authorName(pr)} (you)` : authorName(pr),
    branch: `${b.source} -> ${b.dest}`,
    review: reviewSummary(pr, me),
    builds: statuses === undefined ? "unavailable" : buildsSummary(statuses),
    comments: num(pr["comment_count"]) ?? 0,
    tasks: num(pr["task_count"]) ?? 0,
    updated: relTime(pr["updated_on"]),
    created: relTime(pr["created_on"]),
    url: str(dig(pr, "links", "html", "href")),
    reviewers: reviewerRows.length > 0 ? reviewerRows : "none",
    description: body.text || "none",
  };

  const help: string[] = [];
  if (body.truncated) help.push(`Run \`bb-axi pr view ${id} --full${hint}\` for the complete description`);
  help.push(`Run \`bb-axi pr diff ${id}${hint}\` for the annotated diff`);
  if ((num(pr["comment_count"]) ?? 0) > 0) {
    help.push(`Run \`bb-axi pr comments ${id}${hint}\` to read the discussion`);
  }
  if (state === "open" && myReviewStatus(pr, me) === "pending") {
    help.push(`Run \`bb-axi pr approve ${id}${hint}\` or \`bb-axi pr request-changes ${id}${hint}\` when done`);
  }
  return out(block({ pr: detail }), helpBlock(help));
}
