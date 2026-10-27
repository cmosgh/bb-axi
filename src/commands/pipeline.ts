import { bool, expectPositionals, flag, intFlag, parseArgs, parseFields, positiveId } from "../args.js";
import { bbJson, bbPaginate, bbText } from "../client.js";
import { repoHint, repoPath, requireRepo, type RepoContext } from "../context.js";
import { axiError, AxiError, usageError } from "../errors.js";
import { block, countLine, dig, duration, fenced, helpBlock, num, obj, out, relTime, str, truncateTail, type Obj } from "../render.js";

export const PIPELINE_HELP = `usage: bb-axi pipeline <subcommand> [args] [flags]
subcommands[5]:
  list, view <build-number>, log <build-number>, rerun <build-number>, stop <build-number>
flags{list}:
  --branch <name>, --limit <1-100> (default 20), --fields <commit,duration,creator,trigger>
flags{log}:
  --step <n> (default: first failed step, else the last step), --full (whole log instead of the tail)
flags{rerun,stop}:
  --confirm (without it: preview only). rerun starts a new build of every step on the same commit and pipeline; needs write:pipeline:bitbucket
global:
  -R/--repo <workspace>/<repo>
examples[4]:
  bb-axi pipeline list --branch main
  bb-axi pipeline view 1284
  bb-axi pipeline log 1284
  bb-axi pipeline rerun 1284 --confirm
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

const SUBCOMMANDS = ["list", "view", "log", "rerun", "stop"] as const;

export async function pipelineCommand(args: string[], ctx?: RepoContext): Promise<string> {
  const [sub, ...rest] = args;
  if (!SUBCOMMANDS.includes(sub as (typeof SUBCOMMANDS)[number])) {
    throw usageError(sub ? `unknown pipeline subcommand '${sub}'` : "missing pipeline subcommand", [
      "subcommands: list, view <build-number>, log <build-number>, rerun <build-number>, stop <build-number>",
      "Run `bb-axi pipeline --help` for flags",
    ]);
  }
  const repo = requireRepo(ctx);
  if (sub === "list") return pipelineList(rest, repo);
  if (sub === "view") return pipelineView(rest, repo);
  if (sub === "rerun") return pipelineRerun(rest, repo);
  if (sub === "stop") return pipelineStop(rest, repo);
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
      ref: refName(p),
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
async function resolvePipeline(ctx: RepoContext, buildNumber: number, newest?: Obj): Promise<Obj> {
  const base = `${repoPath(ctx)}/pipelines`;
  const pagelen = 100;
  const first = newest ?? (await fetchNewest(ctx));
  const find = (page: Obj): Obj | undefined =>
    (Array.isArray(page["values"]) ? page["values"] : [])
      .map(obj)
      .find((p) => num(p["build_number"]) === buildNumber);

  const hit = find(first);
  if (hit) return hit;

  const latest = num(obj((first["values"] as unknown[] | undefined)?.[0])["build_number"]);
  if (latest !== undefined && buildNumber < latest) {
    const targetPage = Math.floor((latest - buildNumber) / pagelen) + 1;
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

async function fetchNewest(ctx: RepoContext): Promise<Obj> {
  return obj(await bbJson(`${repoPath(ctx)}/pipelines`, { query: { sort: "-created_on", pagelen: 100 } }));
}

/** Pull request targets carry the branch as `source`, not `ref_name`. */
function refName(pipeline: Obj): string {
  const target = obj(pipeline["target"]);
  return str(target["ref_name"]) || str(target["source"]) || str(dig(target, "selector", "pattern")) || "unknown";
}

function isCompleted(pipeline: Obj): boolean {
  return str(dig(pipeline, "state", "name")) === "COMPLETED";
}

function selectorLabel(pipeline: Obj): string {
  const type = str(dig(pipeline, "target", "selector", "type")) || "default";
  const pattern = str(dig(pipeline, "target", "selector", "pattern"));
  return pattern && pattern !== type ? `${type} ${pattern}` : type;
}

/** The GET target carries read-only expansions; POST wants refs and hashes only. */
export function rerunTarget(target: Obj): Obj {
  const clean: Obj = {};
  for (const [key, value] of Object.entries(target)) {
    if (key === "commit" || key === "destination_commit") {
      const hash = str(obj(value)["hash"]);
      if (hash) clean[key] = { type: "commit", hash };
    } else if (key === "pullrequest") {
      clean[key] = { id: String(obj(value)["id"] ?? "") };
    } else if (key === "selector") {
      const selector = obj(value);
      clean[key] = { type: str(selector["type"]), ...(selector["pattern"] ? { pattern: str(selector["pattern"]) } : {}) };
    } else if (typeof value === "string") {
      clean[key] = value;
    }
  }
  return clean;
}

async function pipelineRerun(args: string[], ctx: RepoContext): Promise<string> {
  const command = "bb-axi pipeline rerun";
  const parsed = parseArgs(args, [{ name: "--confirm", boolean: true }], command);
  const [raw] = expectPositionals(parsed, 1, `${command} <build-number> --confirm`);
  const build = positiveId(raw, "build number");
  const hint = repoHint(ctx);

  const newest = await fetchNewest(ctx);
  const pipeline = await resolvePipeline(ctx, build, newest);
  const target = obj(pipeline["target"]);
  const commit = str(dig(target, "commit", "hash"));
  const ref = refName(pipeline);
  const selector = selectorLabel(pipeline);

  if (!isCompleted(pipeline)) {
    return out(
      block({ build, result: `still ${pipelineStatus(pipeline)} (no-op)` }),
      helpBlock([`Run \`bb-axi pipeline stop ${build}${hint}\` to stop it first`]),
    );
  }
  // A run of the same commit and pipeline already in flight means a rerun was started.
  const inFlight = (Array.isArray(newest["values"]) ? newest["values"] : [])
    .map(obj)
    .find(
      (p) =>
        (num(p["build_number"]) ?? 0) > build &&
        !isCompleted(p) &&
        str(dig(p, "target", "commit", "hash")) === commit &&
        selectorLabel(p) === selector,
    );
  if (inFlight) {
    const running = num(inFlight["build_number"]);
    return out(
      block({ build, result: `build ${running} already runs the same commit and pipeline (no-op)` }),
      helpBlock([`Run \`bb-axi pipeline view ${running}${hint}\` for its steps`]),
    );
  }

  const variables = (Array.isArray(pipeline["variables"]) ? pipeline["variables"] : []).map(obj);
  if (variables.some((v) => v["secured"] === true)) {
    throw axiError(`build ${build} used secured variables - their values cannot be read back for a rerun`, "VALIDATION_ERROR", [
      "Rerun it from the Bitbucket UI",
    ]);
  }

  if (!bool(parsed, "--confirm")) {
    return out(
      block({
        rerun_preview: {
          build,
          status: pipelineStatus(pipeline),
          ref,
          commit: commit.slice(0, 8),
          pipeline: selector,
          variables: variables.length,
          result: "NOT started - preview only (reruns every step including deployments)",
        },
      }),
      helpBlock([`Run \`bb-axi pipeline rerun ${build} --confirm${hint}\` to start a new build`]),
    );
  }

  const body: Obj = { target: rerunTarget(target) };
  if (variables.length > 0) {
    body["variables"] = variables.map((v) => ({ key: str(v["key"]), value: str(v["value"]) }));
  }
  const created = obj(await bbJson(`${repoPath(ctx)}/pipelines/`, { method: "POST", body }));
  const next = num(created["build_number"]);
  return out(
    block({
      build: next ?? "unknown",
      result: `started - rerun of build ${build}`,
      ref,
      commit: commit.slice(0, 8),
      pipeline: selector,
    }),
    helpBlock(next === undefined ? [] : [`Run \`bb-axi pipeline view ${next}${hint}\` to follow its steps`]),
  );
}

async function pipelineStop(args: string[], ctx: RepoContext): Promise<string> {
  const command = "bb-axi pipeline stop";
  const parsed = parseArgs(args, [{ name: "--confirm", boolean: true }], command);
  const [raw] = expectPositionals(parsed, 1, `${command} <build-number> --confirm`);
  const build = positiveId(raw, "build number");
  const hint = repoHint(ctx);

  const pipeline = await resolvePipeline(ctx, build);
  if (isCompleted(pipeline)) {
    return block({ build, result: `already finished - ${pipelineStatus(pipeline)} (no-op)` });
  }
  if (!bool(parsed, "--confirm")) {
    return out(
      block({
        stop_preview: {
          build,
          status: pipelineStatus(pipeline),
          ref: refName(pipeline),
          pipeline: selectorLabel(pipeline),
          result: "NOT stopped - preview only (running steps are halted mid-way)",
        },
      }),
      helpBlock([`Run \`bb-axi pipeline stop ${build} --confirm${hint}\` to stop it`]),
    );
  }
  await bbJson(`${repoPath(ctx)}/pipelines/${encodeURIComponent(str(pipeline["uuid"]))}/stopPipeline`, { method: "POST" });
  return out(
    block({ build, result: "stop requested" }),
    helpBlock([
      `Run \`bb-axi pipeline view ${build}${hint}\` to confirm it stopped`,
      `Run \`bb-axi pipeline rerun ${build}${hint}\` to preview a fresh run`,
    ]),
  );
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
        ref: refName(pipeline),
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
    fenced("log", text.text.trimEnd() || "(empty log)"),
    helpBlock(text.truncated ? [`Run \`bb-axi pipeline log ${build} --step ${index + 1} --full${hint}\` for the whole log`] : []),
  );
}
