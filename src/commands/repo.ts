import { bool, expectPositionals, flag, intFlag, parseArgs, positiveId } from "../args.js";
import { bbJson, bbPaginate, bbText } from "../client.js";
import { repoHint, repoPath, requireRepo, type RepoContext } from "../context.js";
import { AxiError, axiError, usageError } from "../errors.js";
import { fetchPr } from "../pr-api.js";
import { block, countLine, dig, fenced, helpBlock, num, obj, out, relTime, str, truncate } from "../render.js";

export const REPO_HELP = `usage: bb-axi repo <subcommand> [flags]
subcommands[3]:
  view, list, file <path>
flags{list}:
  --workspace <slug> (default: workspace of the current repository), --query <BBQL> (e.g. name~"api"), --limit <1-200> (default 50)
flags{file}:
  --ref <branch|tag|commit> (default: main branch) | --pr <id> (the PR's source commit), --full (do not truncate)
notes:
  file prints a file between --- fences or lists a directory (use . for the root). Branch names with '/' are resolved to their commit.
global:
  -R/--repo <workspace>/<repo>
examples[4]:
  bb-axi repo view
  bb-axi repo list --workspace acme --query 'name~"api"'
  bb-axi repo file src/app/a.ts --ref feature/x
  bb-axi repo file src/app/ --pr 42
`;

export async function repoCommand(args: string[], ctx?: RepoContext): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "view") return repoView(rest, requireRepo(ctx));
  if (sub === "list") return repoList(rest, ctx);
  if (sub === "file") return repoFile(rest, requireRepo(ctx));
  throw usageError(sub ? `unknown repo subcommand '${sub}'` : "missing repo subcommand", [
    "subcommands: view, list, file",
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

const FILE_LIMIT = 20_000;

/** The src endpoint 404s on branch names containing '/', so always address a commit. */
async function resolveCommit(ctx: RepoContext, ref: string | undefined, prId: number | undefined): Promise<{ hash: string; label: string }> {
  if (prId !== undefined) {
    const pr = await fetchPr(ctx, prId);
    return { hash: str(dig(pr, "source", "commit", "hash")), label: `pr ${prId} (${str(dig(pr, "source", "branch", "name"))})` };
  }
  if (ref !== undefined && /^[0-9a-f]{7,40}$/i.test(ref)) return { hash: ref, label: ref };
  const name = ref ?? str(dig(await bbJson(repoPath(ctx)), "mainbranch", "name"));
  for (const kind of ["branches", "tags"]) {
    try {
      const target = await bbJson(`${repoPath(ctx)}/refs/${kind}/${encodeURIComponent(name)}`, { query: { fields: "target.hash" } });
      return { hash: str(dig(target, "target", "hash")), label: name };
    } catch (error) {
      if (!(error instanceof AxiError && error.code === "NOT_FOUND")) throw error;
    }
  }
  throw axiError(`no branch or tag '${name}' in ${ctx.slug}`, "NOT_FOUND", [
    `Run \`bb-axi api /repositories/{workspace}/{repo}/refs/branches --query q='name~"${name}"'${repoHint(ctx)}\` to find it`,
  ]);
}

async function repoFile(args: string[], ctx: RepoContext): Promise<string> {
  const command = "bb-axi repo file";
  const parsed = parseArgs(args, [{ name: "--ref" }, { name: "--pr" }, { name: "--full", boolean: true }], command);
  const usage = `${command} <path> [--ref <branch|tag|commit> | --pr <id>]`;
  const [raw] = expectPositionals(parsed, 1, usage);
  const ref = flag(parsed, "--ref");
  const prFlag = flag(parsed, "--pr");
  if (ref !== undefined && prFlag !== undefined) throw usageError("pass --ref or --pr, not both", [`usage: ${usage}`]);
  const prId = prFlag === undefined ? undefined : positiveId(prFlag, "pull request id");
  const path = raw!.replace(/^\.?\/+/, "").replace(/^\.$/, "");
  if (path.split("/").includes("..")) throw usageError("path must not contain '..'");

  const { hash, label } = await resolveCommit(ctx, ref, prId);
  const url = `${repoPath(ctx)}/src/${encodeURIComponent(hash)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const meta = obj(await bbJson(url, { query: { format: "meta" } }));
  const short = hash.slice(0, 12);
  const refArgs = `${ref ? ` --ref ${ref}` : ""}${prId ? ` --pr ${prId}` : ""}${repoHint(ctx)}`;

  if (str(meta["type"]) === "commit_directory") {
    const page = await bbPaginate(url.endsWith("/") ? url : `${url}/`, { limit: 500, pagelen: 100 });
    const prefix = path === "" ? "" : `${path.replace(/\/+$/, "")}/`;
    const entries = page.values.map((value) => {
      const entry = obj(value);
      const dir = str(entry["type"]) === "commit_directory";
      return { name: `${str(entry["path"]).slice(prefix.length)}${dir ? "/" : ""}`, size: dir ? "dir" : (num(entry["size"]) ?? 0) };
    });
    return out(
      block({ dir: path || "/", ref: label, commit: short, count: countLine(entries.length, page.size, page.more), entries }),
      helpBlock([`Run \`${command} ${prefix}<name>${refArgs}\` to read a file`]),
    );
  }

  const content = await bbText(url);
  if (content.includes("\u0000")) return block({ file: path, ref: label, commit: short, size: num(meta["size"]) ?? content.length, content: "binary - not shown" });
  const text = bool(parsed, "--full") ? { text: content, truncated: false } : truncate(content, FILE_LIMIT);
  return out(
    block({ file: path, ref: label, commit: short, lines: content.trimEnd().split("\n").length }),
    fenced("content", text.text.trimEnd() || "(empty file)"),
    helpBlock(text.truncated ? [`Run \`${command} ${path} --full${refArgs}\` for the whole file`] : []),
  );
}
