import { bool, enumFlag, expectPositionals, flag, flags, parseArgs, positiveId, requireFlag } from "../args.js";
import { bbJson, bbPaginate } from "../client.js";
import { currentBranch, repoHint, repoPath, type RepoContext } from "../context.js";
import { axiError, usageError } from "../errors.js";
import { currentUser } from "../me.js";
import { fetchPr, prPath, stateClause } from "../pr-api.js";
import { branches, buildsSummary, isAuthor, myReviewStatus, prState, reviewSummary } from "../pr-model.js";
import { arr, block, dig, helpBlock, num, obj, out, str, type Obj } from "../render.js";
import { readBody } from "./pr-comments.js";

function requireOpen(pr: Obj, id: number, action: string): void {
  const state = prState(pr);
  if (state !== "open") {
    throw axiError(`cannot ${action} pull request ${id}: it is ${state}`, "CONFLICT");
  }
}

/** approve=true -> approve, approve=false -> withdraw approval. Both idempotent. */
export async function prApprove(args: string[], ctx: RepoContext, approve: boolean): Promise<string> {
  const command = `bb-axi pr ${approve ? "approve" : "unapprove"}`;
  const parsed = parseArgs(args, [], command);
  const [rawId] = expectPositionals(parsed, 1, `${command} <id>`);
  const id = positiveId(rawId, "pull request id");
  const hint = repoHint(ctx);

  const [pr, me] = await Promise.all([fetchPr(ctx, id), currentUser()]);
  const mine = myReviewStatus(pr, me);
  if (approve && mine === "approved") {
    return block({ pr: id, result: "already approved by you (no-op)", review: reviewSummary(pr, me) });
  }
  if (!approve && me && mine !== "approved") {
    return block({ pr: id, result: "not approved by you (no-op)", review: reviewSummary(pr, me) });
  }
  requireOpen(pr, id, approve ? "approve" : "unapprove");
  if (approve && isAuthor(pr, me)) {
    throw axiError(`cannot approve pull request ${id}: you are its author`, "CONFLICT");
  }

  await bbJson(`${prPath(ctx, id)}/approve`, { method: approve ? "POST" : "DELETE" });
  const after = await fetchPr(ctx, id).catch(() => pr);
  return out(
    block({ pr: id, result: approve ? "approved" : "approval withdrawn", review: reviewSummary(after, me) }),
    helpBlock(approve ? [`Run \`bb-axi pr merge ${id}${hint}\` to preview a merge`] : []),
  );
}

export async function prRequestChanges(args: string[], ctx: RepoContext, request: boolean): Promise<string> {
  const command = `bb-axi pr ${request ? "request-changes" : "unrequest-changes"}`;
  const parsed = parseArgs(args, [], command);
  const [rawId] = expectPositionals(parsed, 1, `${command} <id>`);
  const id = positiveId(rawId, "pull request id");
  const hint = repoHint(ctx);

  const [pr, me] = await Promise.all([fetchPr(ctx, id), currentUser()]);
  const mine = myReviewStatus(pr, me);
  if (request && mine === "changes_requested") {
    return block({ pr: id, result: "changes already requested by you (no-op)", review: reviewSummary(pr, me) });
  }
  if (!request && me && mine !== "changes_requested") {
    return block({ pr: id, result: "no change request by you (no-op)", review: reviewSummary(pr, me) });
  }
  requireOpen(pr, id, request ? "request changes on" : "withdraw the change request on");
  if (request && isAuthor(pr, me)) {
    throw axiError(`cannot request changes on pull request ${id}: you are its author`, "CONFLICT");
  }

  await bbJson(`${prPath(ctx, id)}/request-changes`, { method: request ? "POST" : "DELETE" });
  const after = await fetchPr(ctx, id).catch(() => pr);
  return out(
    block({
      pr: id,
      result: request ? "changes requested" : "change request withdrawn",
      review: reviewSummary(after, me),
    }),
    helpBlock(
      request ? [`Explain why: \`bb-axi pr comment ${id} --body "<text>"${hint}\``] : [],
    ),
  );
}

async function resolveReviewers(ctx: RepoContext, names: string[], includeDefaults: boolean, myUuid: string | undefined): Promise<Obj[]> {
  const uuids = new Set<string>();
  const unresolved: string[] = [];

  for (const name of names) {
    if (/^\{[0-9a-fA-F-]{36}\}$/.test(name)) uuids.add(name);
    else unresolved.push(name);
  }

  if (unresolved.length > 0 || includeDefaults) {
    // Workspace members are the only lookup Bitbucket offers for names; default
    // reviewers cover the common case without needing member-read scope.
    const defaults = await bbPaginate(`${repoPath(ctx)}/effective-default-reviewers`, {
      limit: 100,
      pagelen: 100,
    }).then((page) => page.values.map((v) => obj(obj(v)["user"])));
    if (includeDefaults) {
      for (const user of defaults) uuids.add(str(user["uuid"]));
    }
    let candidates = defaults;
    if (unresolved.some((n) => !defaults.some((u) => sameName(u, n)))) {
      const members = await bbPaginate(`/workspaces/${encodeURIComponent(ctx.workspace)}/members`, {
        limit: 500,
        pagelen: 100,
      })
        .then((page) => page.values.map((v) => obj(obj(v)["user"])))
        .catch(() => [] as Obj[]);
      candidates = [...defaults, ...members];
    }
    for (const name of unresolved) {
      const matches = [...new Map(candidates.filter((u) => sameName(u, name)).map((u) => [str(u["uuid"]), u])).values()];
      if (matches.length !== 1) {
        throw usageError(
          matches.length === 0 ? `no workspace member matches reviewer '${name}'` : `reviewer '${name}' is ambiguous`,
          ["Pass the exact display name, or the account uuid in {braces}"],
        );
      }
      uuids.add(str(matches[0]!["uuid"]));
    }
  }

  // Bitbucket rejects a PR whose author is also a reviewer.
  if (myUuid) uuids.delete(myUuid);
  uuids.delete("");
  return [...uuids].map((uuid) => ({ uuid }));
}

function sameName(user: Obj, name: string): boolean {
  const wanted = name.trim().toLowerCase();
  return (
    str(user["display_name"]).toLowerCase() === wanted || str(user["nickname"]).toLowerCase() === wanted
  );
}

export async function prCreate(args: string[], ctx: RepoContext): Promise<string> {
  const command = "bb-axi pr create";
  const usage = `${command} --title "<title>" [--source <branch>] [--dest <branch>] [--body "<text>"] [--reviewer <name>] [--default-reviewers] [--draft]`;
  const parsed = parseArgs(
    args,
    [
      { name: "--title" },
      { name: "--source" },
      { name: "--dest" },
      { name: "--body" },
      { name: "--body-file" },
      { name: "--reviewer", repeatable: true },
      { name: "--default-reviewers", boolean: true },
      { name: "--draft", boolean: true },
      { name: "--close-source", boolean: true },
    ],
    command,
  );
  expectPositionals(parsed, 0, usage);
  const title = requireFlag(parsed, "--title", usage);
  const source = flag(parsed, "--source") ?? (ctx.source === "git" ? currentBranch() : undefined);
  if (!source) throw usageError("--source <branch> is required", [usage]);
  const dest = flag(parsed, "--dest");
  const hasBody = flag(parsed, "--body") !== undefined || flag(parsed, "--body-file") !== undefined;
  const hint = repoHint(ctx);

  // Idempotent: an open PR for the same source (and destination) already is the desired state.
  const me = await currentUser();
  // `state="OPEN"` goes in the BBQL too: Bitbucket ignores the `state`
  // parameter whenever `q` is present, and without it a MERGED or DECLINED PR
  // on the same branch would be reported as "already open" and block the create.
  const existingQuery = [
    stateClause(["OPEN"]),
    `source.branch.name="${source.replace(/"/g, '\\"')}"`,
  ];
  if (dest) existingQuery.push(`destination.branch.name="${dest.replace(/"/g, '\\"')}"`);
  const existing = await bbPaginate(`${repoPath(ctx)}/pullrequests`, {
    query: { state: "OPEN", q: existingQuery.join(" AND ") },
    limit: 1,
    pagelen: 1,
  });
  const found = existing.values[0];
  if (found) {
    const b = branches(found);
    return out(
      block({
        pr: {
          id: num(obj(found)["id"]) ?? null,
          title: str(obj(found)["title"]),
          branch: `${b.source} -> ${b.dest}`,
          result: "already open for this branch (no-op)",
          url: str(dig(found, "links", "html", "href")),
        },
      }),
      helpBlock([`Run \`bb-axi pr view ${num(obj(found)["id"]) ?? "<id>"}${hint}\` to inspect it`]),
    );
  }

  const reviewerList = await resolveReviewers(
    ctx,
    flags(parsed, "--reviewer"),
    bool(parsed, "--default-reviewers"),
    me?.uuid,
  );
  const payload: Obj = { title, source: { branch: { name: source } } };
  if (dest) payload["destination"] = { branch: { name: dest } };
  if (hasBody) payload["description"] = readBody(parsed, usage);
  if (reviewerList.length > 0) payload["reviewers"] = reviewerList;
  if (bool(parsed, "--draft")) payload["draft"] = true;
  if (bool(parsed, "--close-source")) payload["close_source_branch"] = true;

  const created = obj(await bbJson(`${repoPath(ctx)}/pullrequests`, { method: "POST", body: payload }));
  const id = num(created["id"]);
  const b = branches(created);
  return out(
    block({
      pr: {
        id: id ?? null,
        title: str(created["title"]) || title,
        state: created["draft"] === true ? "open (draft)" : "open",
        branch: `${b.source} -> ${b.dest}`,
        reviewers: arr(created["reviewers"]).length,
        result: "created",
        url: str(dig(created, "links", "html", "href")),
      },
    }),
    helpBlock(id !== undefined ? [`Run \`bb-axi pr view ${id}${hint}\` to check builds and reviewers`] : []),
  );
}

const STRATEGIES = ["merge_commit", "squash", "fast_forward"] as const;

export async function prMerge(args: string[], ctx: RepoContext): Promise<string> {
  const command = "bb-axi pr merge";
  const parsed = parseArgs(
    args,
    [
      { name: "--confirm", boolean: true },
      { name: "--strategy" },
      { name: "--message" },
      { name: "--close-source", boolean: true },
    ],
    command,
  );
  const [rawId] = expectPositionals(parsed, 1, `${command} <id> --confirm [--strategy <merge_commit|squash|fast_forward>]`);
  const id = positiveId(rawId, "pull request id");
  const strategy = flag(parsed, "--strategy") === undefined ? undefined : enumFlag(parsed, "--strategy", STRATEGIES, "merge_commit");
  const hint = repoHint(ctx);

  const [pr, me] = await Promise.all([fetchPr(ctx, id), currentUser()]);
  const state = prState(pr);
  const b = branches(pr);
  if (state === "merged") {
    return block({ pr: id, result: "already merged (no-op)", branch: `${b.source} -> ${b.dest}` });
  }
  requireOpen(pr, id, "merge");

  if (!bool(parsed, "--confirm")) {
    const statuses = await bbPaginate(`${prPath(ctx, id)}/statuses`, { limit: 50, pagelen: 50 })
      .then((page) => page.values)
      .catch(() => undefined);
    return out(
      block({
        merge_preview: {
          pr: id,
          title: str(pr["title"]),
          branch: `${b.source} -> ${b.dest}`,
          strategy: strategy ?? "repository default",
          review: reviewSummary(pr, me),
          builds: statuses === undefined ? "unavailable" : buildsSummary(statuses),
          open_tasks: num(pr["task_count"]) ?? 0,
          result: "NOT merged - preview only",
        },
      }),
      helpBlock([`Run \`bb-axi pr merge ${id} --confirm${strategy ? ` --strategy ${strategy}` : ""}${hint}\` to merge`]),
    );
  }

  const payload: Obj = {};
  if (strategy) payload["merge_strategy"] = strategy;
  const message = flag(parsed, "--message");
  if (message) payload["message"] = message;
  if (bool(parsed, "--close-source")) payload["close_source_branch"] = true;

  const merged = obj(await bbJson(`${prPath(ctx, id)}/merge`, { method: "POST", body: payload, timeoutMs: 120_000 }));
  return block({
    pr: id,
    result: prState(merged) === "merged" ? "merged" : `merge accepted (state: ${prState(merged)})`,
    branch: `${b.source} -> ${b.dest}`,
    commit: str(dig(merged, "merge_commit", "hash")).slice(0, 12) || "pending",
  });
}

export async function prDecline(args: string[], ctx: RepoContext): Promise<string> {
  const command = "bb-axi pr decline";
  const parsed = parseArgs(args, [{ name: "--confirm", boolean: true }], command);
  const [rawId] = expectPositionals(parsed, 1, `${command} <id> --confirm`);
  const id = positiveId(rawId, "pull request id");
  const hint = repoHint(ctx);

  const pr = await fetchPr(ctx, id);
  if (prState(pr) === "declined") {
    return block({ pr: id, result: "already declined (no-op)" });
  }
  requireOpen(pr, id, "decline");

  if (!bool(parsed, "--confirm")) {
    const b = branches(pr);
    return out(
      block({
        decline_preview: {
          pr: id,
          title: str(pr["title"]),
          branch: `${b.source} -> ${b.dest}`,
          result: "NOT declined - preview only (declining cannot be undone)",
        },
      }),
      helpBlock([`Run \`bb-axi pr decline ${id} --confirm${hint}\` to decline`]),
    );
  }

  await bbJson(`${prPath(ctx, id)}/decline`, { method: "POST" });
  return block({ pr: id, result: "declined" });
}
