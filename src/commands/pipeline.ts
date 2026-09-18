import { bool, expectPositionals, flag, intFlag, parseArgs, parseFields, positiveId } from "../args.js";
import { bbJson, bbPaginate, bbText } from "../client.js";
import { repoHint, repoPath, requireRepo, type RepoContext } from "../context.js";
import { axiError, AxiError, usageError } from "../errors.js";
import { block, countLine, dig, duration, helpBlock, num, obj, out, relTime, str, truncateTail, type Obj } from "../render.js";

export const PIPELINE_HELP = `usage: bb-axi pipeline <subcommand> [args] [flags]
subcommands[3]:
  list, view <build-number>, log <build-number>
flags{list}:
  --branch <name>, --limit <1-100> (default 20), --fields <commit,duration,creator,trigger>
flags{log}:
  --step <n> (default: first failed step, else the last step), --full (whole log instead of the tail)
global:
  -R/--repo <workspace>/<repo>
examples[3]:
  bb-axi pipeline list --branch main
  bb-axi pipeline view 1284
  bb-axi pipeline log 1284
`;

const LIST_EXTRA_FIELDS = ["commit", "duration", "creator", "trigger"] as const;
const LOG_TAIL_CHARS = 6_000;

/** Collapse Bitbucket's nested state/result/stage into one word. */
export function pipelineStatus(entity: unknown): string {
  const state = obj(obj(entity)["state"]);
  const result = str(dig(state, "result", "name"));
  const stage = str(dig(state, "stage", "name"));
  const name = result || stage || str(state["name"]) || "unknown";
  return name.toLowerCase().replace(/\s+/g, "_");
}

export async function pipelineCommand(args: string[], ctx?: RepoContext): Promise<string> {
  const [sub, ...rest] = args;
  if (sub !== "list" && sub !== "view" && sub !== "log") {
    throw usageError(sub ? `unknown pipeline subcommand '${sub}'` : "missing pipeline subcommand", [
      "subcommands: list, view <build-number>, log <build-number>",
      "Run `bb-axi pipeline --help` for flags",
    ]);
  }
  const repo = requireRepo(ctx);
  if (sub === "list") return pipelineList(rest, repo);
  if (sub === "view") return pipelineView(rest, repo);
  return pipelineLog(rest, repo);
}

async function pipelineList(args: string[], ctx: RepoContext): Promise<string> {
  const command = "bb-axi pipeline list";
  const parsed = parseArgs(args, [{ name: "--branch" }, { name: "--limit" }, { name: "--fields" }], command);
  expectPositionals(parsed, 0, `${command} [flags]`);
  const limit = intFlag(parsed, "--limit", 20, { min: 1, max: 100 });
  const extras = parseFields(flag(parsed, "--fields"), LIST_EXTRA_FIELDS);
  const branch = flag(parsed, "--branch");
  const hint = repoHint(ctx);

  const page = await bbPaginate(`${repoPath(ctx)}/pipelines`, {
    query: { sort: "-created_on", "target.branch": branch },
    limit,
    pagelen: 100,
  });

  if (page.values.length === 0) {
    return block({
      pipelines: `0 pipeline runs${branch ? ` on branch ${branch}` : ""} in ${ctx.slug}`,
    });
  }

  const rows = page.values.map((value) => {
    const p = obj(value);
    const row: Obj = {
      build: num(p["build_number"]) ?? null,
      status: pipelineStatus(p),
      ref: str(dig(p, "target", "ref_name")) || str(dig(p, "target", "selector", "pattern")) || "unknown",
      age: relTime(p["created_on"]),
    };
    for (const extra of extras) {
      if (extra === "commit") row["commit"] = str(dig(p, "target", "commit", "hash")).slice(0, 8);
      else if (extra === "duration") row["duration"] = duration(p["duration_in_seconds"]);
      else if (extra === "creator") row["creator"] = str(dig(p, "creator", "display_name")) || "unknown";
      else if (extra === "trigger") row["trigger"] = str(dig(p, "trigger", "name")).toLowerCase() || "unknown";
    }
    return row;
  });

  const help = [`Run \`bb-axi pipeline view <build-number>${hint}\` for steps`];
  if (rows.some((r) => r["status"] === "failed")) {
    help.push(`Run \`bb-axi pipeline log <build-number>${hint}\` for the failing step's log tail`);
  }
  return out(block({ count: countLine(rows.length, page.size, page.more), pipelines: rows }), helpBlock(help));
}

/**
 * Bitbucket addresses pipelines by uuid, agents by build number. Build numbers
 * are sequential, so the newest page tells us which page holds the target.
 */
async function resolvePipeline(ctx: RepoContext, buildNumber: number): Promise<Obj> {
  const base = `${repoPath(ctx)}/pipelines`;
  const pagelen = 100;
  const first = obj(await bbJson(base, { query: { sort: "-created_on", pagelen } }));
  const find = (page: Obj): Obj | undefined =>
    (Array.isArray(page["values"]) ? page["values"] : [])
      .map(obj)
      .find((p) => num(p["build_number"]) === buildNumber);

  const hit = find(first);
  if (hit) return hit;

  const newest = num(obj((first["values"] as unknown[] | undefined)?.[0])["build_number"]);
  if (newest !== undefined && buildNumber < newest) {
    const targetPage = Math.floor((newest - buildNumber) / pagelen) + 1;
    // Deleted runs shift the offset slightly, so probe the neighbours too.
    for (const pageNumber of [targetPage, targetPage - 1, targetPage + 1]) {
      if (pageNumber < 2) continue;
      const page = obj(await bbJson(base, { query: { sort: "-created_on", pagelen, page: pageNumber } }));
      const found = find(page);
      if (found) return found;
    }
  }
  throw axiError(`pipeline build ${buildNumber} not found in ${ctx.slug}`, "NOT_FOUND", [
    `Run \`bb-axi pipeline list${repoHint(ctx)}\` to see recent build numbers`,
  ]);
}

async function fetchSteps(ctx: RepoContext, pipelineUuid: string): Promise<Obj[]> {
  const page = await bbPaginate(`${repoPath(ctx)}/pipelines/${encodeURIComponent(pipelineUuid)}/steps`, {
    limit: 100,
    pagelen: 100,
  });
  return page.values.map(obj);
}

async function pipelineView(args: string[], ctx: RepoContext): Promise<string> {
  const command = "bb-axi pipeline view";
  const parsed = parseArgs(args, [], command);
  const [raw] = expectPositionals(parsed, 1, `${command} <build-number>`);
  const build = positiveId(raw, "build number");
  const hint = repoHint(ctx);

  const pipeline = await resolvePipeline(ctx, build);
  const steps = await fetchSteps(ctx, str(pipeline["uuid"]));
  const status = pipelineStatus(pipeline);

  const stepRows = steps.map((step, index) => ({
    n: index + 1,
    name: str(step["name"]) || `step ${index + 1}`,
    status: pipelineStatus(step),
    duration: duration(step["duration_in_seconds"]),
  }));

  return out(
    block({
      pipeline: {
        build,
        status,
        ref: str(dig(pipeline, "target", "ref_name")) || "unknown",
        commit: str(dig(pipeline, "target", "commit", "hash")).slice(0, 8),
        trigger: str(dig(pipeline, "trigger", "name")).toLowerCase() || "unknown",
        creator: str(dig(pipeline, "creator", "display_name")) || "unknown",
        duration: duration(pipeline["duration_in_seconds"]),
        started: relTime(pipeline["created_on"]),
        steps: stepRows.length > 0 ? stepRows : "none",
      },
    }),
    helpBlock(
      stepRows.length > 0 && status !== "successful"
        ? [`Run \`bb-axi pipeline log ${build}${hint}\` for the ${status === "failed" ? "failing" : "latest"} step's log tail`]
        : [],
    ),
  );
}

async function pipelineLog(args: string[], ctx: RepoContext): Promise<string> {
  const command = "bb-axi pipeline log";
  const parsed = parseArgs(args, [{ name: "--step" }, { name: "--full", boolean: true }], command);
  const [raw] = expectPositionals(parsed, 1, `${command} <build-number> [--step <n>] [--full]`);
  const build = positiveId(raw, "build number");
  const hint = repoHint(ctx);

  const pipeline = await resolvePipeline(ctx, build);
  const steps = await fetchSteps(ctx, str(pipeline["uuid"]));
  if (steps.length === 0) {
    return block({ log: `0 steps recorded for pipeline build ${build} (status: ${pipelineStatus(pipeline)})` });
  }

  const requested = flag(parsed, "--step");
  let index: number;
  if (requested !== undefined) {
    index = positiveId(requested, "--step") - 1;
    if (index >= steps.length) {
      throw usageError(`--step ${requested} is out of range: build ${build} has ${steps.length} steps`);
    }
  } else {
    const failed = steps.findIndex((s) => pipelineStatus(s) === "failed" || pipelineStatus(s) === "error");
    index = failed === -1 ? steps.length - 1 : failed;
  }
  const step = steps[index]!;

  let log: string;
  try {
    log = await bbText(
      `${repoPath(ctx)}/pipelines/${encodeURIComponent(str(pipeline["uuid"]))}/steps/${encodeURIComponent(str(step["uuid"]))}/log`,
      { timeoutMs: 60_000 },
    );
  } catch (error) {
    if (error instanceof AxiError && error.code === "NOT_FOUND") {
      return block({
        log: `no log available for step ${index + 1} of build ${build} (status: ${pipelineStatus(step)}) - it may not have started`,
      });
    }
    throw error;
  }

  const text = bool(parsed, "--full") ? { text: log, truncated: false } : truncateTail(log, LOG_TAIL_CHARS);
  return out(
    block({
      build,
      step: `${index + 1}/${steps.length} ${str(step["name"]) || ""}`.trim(),
      status: pipelineStatus(step),
      chars: log.length,
    }),
    "---",
    text.text.trimEnd() || "(empty log)",
    "---",
    helpBlock(text.truncated ? [`Run \`bb-axi pipeline log ${build} --step ${index + 1} --full${hint}\` for the whole log`] : []),
  );
}
