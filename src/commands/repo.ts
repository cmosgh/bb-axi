import { expectPositionals, flag, intFlag, parseArgs } from "../args.js";
import { bbJson, bbPaginate } from "../client.js";
import { repoPath, requireRepo, type RepoContext } from "../context.js";
import { axiError, usageError } from "../errors.js";
import { block, countLine, dig, helpBlock, num, obj, out, relTime, str, truncate } from "../render.js";

export const REPO_HELP = `usage: bb-axi repo <subcommand> [flags]
subcommands[2]:
  view, list
flags{list}:
  --workspace <slug> (default: workspace of the current repository), --query <BBQL> (e.g. name~"api"), --limit <1-200> (default 50)
global:
  -R/--repo <workspace>/<repo>
examples[2]:
  bb-axi repo view
  bb-axi repo list --workspace acme --query 'name~"api"'
`;

export async function repoCommand(args: string[], ctx?: RepoContext): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "view") return repoView(rest, requireRepo(ctx));
  if (sub === "list") return repoList(rest, ctx);
  throw usageError(sub ? `unknown repo subcommand '${sub}'` : "missing repo subcommand", [
    "subcommands: view, list",
  ]);
}

async function repoView(args: string[], ctx: RepoContext): Promise<string> {
  const command = "bb-axi repo view";
  expectPositionals(parseArgs(args, [], command), 0, command);
  const repo = obj(await bbJson(repoPath(ctx)));
  const description = truncate(str(repo["description"]), 500);
  return block({
    repo: {
      slug: ctx.slug,
      project: str(dig(repo, "project", "name")) || "none",
      main_branch: str(dig(repo, "mainbranch", "name")) || "unknown",
      private: repo["is_private"] === true ? "yes" : "no",
      language: str(repo["language"]) || "unknown",
      size_kb: Math.round((num(repo["size"]) ?? 0) / 1024),
      updated: relTime(repo["updated_on"]),
      url: str(dig(repo, "links", "html", "href")),
      description: description.text || "none",
    },
  });
}

async function repoList(args: string[], ctx: RepoContext | undefined): Promise<string> {
  const command = "bb-axi repo list";
  const parsed = parseArgs(args, [{ name: "--workspace" }, { name: "--query" }, { name: "--limit" }], command);
  expectPositionals(parsed, 0, `${command} [--workspace <slug>]`);
  const workspace = flag(parsed, "--workspace") ?? ctx?.workspace;
  if (!workspace) {
    throw axiError("no workspace in context", "REPO_REQUIRED", [
      "Pass `--workspace <slug>`, or run from a Bitbucket checkout",
    ]);
  }
  const limit = intFlag(parsed, "--limit", 50, { min: 1, max: 200 });
  const page = await bbPaginate(`/repositories/${encodeURIComponent(workspace)}`, {
    query: { sort: "-updated_on", q: flag(parsed, "--query") },
    limit,
    pagelen: 100,
  });

  if (page.values.length === 0) {
    return block({ repos: `0 repositories visible in workspace ${workspace}` });
  }
  const rows = page.values.map((value) => ({
    slug: str(obj(value)["slug"]),
    project: str(dig(value, "project", "key")) || "none",
    updated: relTime(obj(value)["updated_on"]),
  }));
  const help = [`Run \`bb-axi pr list -R ${workspace}/<slug>\` for a repository's pull requests`];
  if (page.more) help.push(`Narrow with \`--query 'name~"<text>"'\` or raise \`--limit\` (max 200)`);
  return out(
    block({ workspace, count: countLine(rows.length, page.size, page.more), repos: rows }),
    helpBlock(help),
  );
}
