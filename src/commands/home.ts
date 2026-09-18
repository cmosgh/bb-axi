import { bbPaginate } from "../client.js";
import { repoHint, repoPath, type RepoContext } from "../context.js";
import { resolveCredentials } from "../credentials.js";
import { AxiError } from "../errors.js";
import { currentUser } from "../me.js";
import { authorName, isAuthor, myReviewStatus, PR_LIST_FIELDS, reviewSummary } from "../pr-model.js";
import { block, helpBlock, num, obj, out, relTime, str, type Obj } from "../render.js";

/** The dashboard runs at every session start: keep it fast and tiny. */
const HOME_TIMEOUT_MS = 8_000;
const HOME_ROWS = 5;

export async function homeCommand(_args: string[], ctx?: RepoContext): Promise<string> {
  if (!ctx) {
    // Deliberately no credential lookup and no network here: this path runs in
    // every unrelated directory once the session hook is installed.
    return out(
      block({ repo: "none - not inside a Bitbucket checkout" }),
      helpBlock(["Run `bb-axi pr list -R <workspace>/<repo>` to target a repository explicitly"]),
    );
  }

  const hint = repoHint(ctx);
  const credentials = await resolveCredentials();
  if (!credentials) {
    return out(
      block({ repo: ctx.slug, auth: "not authenticated" }),
      helpBlock(["Run `<token-command> | bb-axi auth login --email <atlassian-email> --token-stdin`"]),
    );
  }

  let prs: unknown[];
  let total: number | undefined;
  let me: Awaited<ReturnType<typeof currentUser>>;
  try {
    const [page, user] = await Promise.all([
      bbPaginate(`${repoPath(ctx)}/pullrequests`, {
        query: { state: "OPEN", sort: "-updated_on", fields: PR_LIST_FIELDS },
        limit: 50,
        pagelen: 50,
        timeoutMs: HOME_TIMEOUT_MS,
      }),
      currentUser({ timeoutMs: HOME_TIMEOUT_MS }),
    ]);
    prs = page.values;
    total = page.size ?? (page.more ? undefined : page.values.length);
    me = user;
  } catch (error) {
    const message = error instanceof AxiError ? error.message : "request failed";
    return out(
      block({ repo: ctx.slug, prs: `unavailable - ${message}` }),
      helpBlock([`Run \`bb-axi auth status\` to check credentials`]),
    );
  }

  const row = (pr: unknown, withAuthor: boolean): Obj => ({
    id: num(obj(pr)["id"]) ?? null,
    title: str(obj(pr)["title"]),
    ...(withAuthor ? { author: authorName(pr) } : { review: reviewSummary(pr, me) }),
    updated: relTime(obj(pr)["updated_on"]),
  });

  const needsMe = prs.filter((pr) => myReviewStatus(pr, me) === "pending" && !isAuthor(pr, me));
  const mine = prs.filter((pr) => isAuthor(pr, me));

  const summary: Obj = {
    repo: ctx.slug,
    open_prs: total ?? `${prs.length}+`,
  };
  if (me) {
    summary["needs_your_review"] =
      needsMe.length > 0 ? needsMe.slice(0, HOME_ROWS).map((pr) => row(pr, true)) : "0 pull requests awaiting your review";
    summary["your_prs"] = mine.length > 0 ? mine.slice(0, HOME_ROWS).map((pr) => row(pr, false)) : "0 open pull requests authored by you";
  }

  const help: string[] = [];
  if (needsMe.length > HOME_ROWS) help.push(`Run \`bb-axi pr list --reviewing${hint}\` for all ${needsMe.length} awaiting your review`);
  if (needsMe.length > 0) help.push(`Run \`bb-axi pr view <id>${hint}\` then \`bb-axi pr diff <id>${hint}\` to review`);
  else if (prs.length > 0) help.push(`Run \`bb-axi pr list${hint}\` for all open pull requests`);
  else help.push(`Run \`bb-axi pr create --title "<title>"${hint}\` to open one from the current branch`);
  help.push("Run `bb-axi --help` for every command (pr, pipeline, repo, api, auth, setup)");

  return out(block(summary), helpBlock(help));
}
