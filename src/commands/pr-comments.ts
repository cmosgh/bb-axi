import { readFileSync } from "node:fs";
import { bool, expectPositionals, flag, flags, intFlag, parseArgs, positiveId, type ParsedArgs } from "../args.js";
import { bbJson, bbPaginate } from "../client.js";
import { repoHint, type RepoContext } from "../context.js";
import { matchesPath } from "../diff.js";
import { axiError, usageError } from "../errors.js";
import { currentUser } from "../me.js";
import { prPath } from "../pr-api.js";
import { authorName, commentLocation } from "../pr-model.js";
import { block, dig, helpBlock, num, obj, out, relTime, str, truncate, type Obj } from "../render.js";

const COMMENT_BODY_LIMIT = 400;

interface Comment {
  id: number;
  parentId: number | undefined;
  raw: Obj;
}

function toComment(value: unknown): Comment {
  const raw = obj(value);
  return { id: num(raw["id"]) ?? 0, parentId: num(dig(raw, "parent", "id")), raw };
}

function body(comment: Comment): string {
  return str(dig(comment.raw, "content", "raw"));
}

async function fetchComments(ctx: RepoContext, id: number, limit: number): Promise<{ comments: Comment[]; more: boolean }> {
  const page = await bbPaginate(`${prPath(ctx, id)}/comments`, {
    query: { sort: "created_on" },
    limit,
    pagelen: 100,
  });
  return {
    comments: page.values.map(toComment).filter((c) => c.raw["deleted"] !== true),
    more: page.more,
  };
}

function rootOf(comment: Comment, byId: Map<number, Comment>): Comment {
  let current = comment;
  const guard = new Set<number>();
  while (current.parentId !== undefined && !guard.has(current.id)) {
    guard.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

function isResolved(root: Comment): boolean {
  const resolution = root.raw["resolution"];
  return resolution !== undefined && resolution !== null;
}

export async function prComments(args: string[], ctx: RepoContext): Promise<string> {
  const command = "bb-axi pr comments";
  const parsed = parseArgs(
    args,
    [
      { name: "--unresolved", boolean: true },
      { name: "--path", repeatable: true },
      { name: "--limit" },
      { name: "--full", boolean: true },
    ],
    command,
  );
  const [rawId] = expectPositionals(parsed, 1, `${command} <id> [--unresolved] [--path <file|dir|glob>] [--full]`);
  const id = positiveId(rawId, "pull request id");
  const limit = intFlag(parsed, "--limit", 100, { min: 1, max: 500 });
  const paths = flags(parsed, "--path");
  const hint = repoHint(ctx);

  const { comments, more } = await fetchComments(ctx, id, limit);
  const byId = new Map(comments.map((c) => [c.id, c]));

  // Group into threads: a root followed by its replies in chronological order.
  const threads = new Map<number, Comment[]>();
  for (const comment of comments) {
    const root = rootOf(comment, byId);
    const list = threads.get(root.id) ?? [];
    if (comment.id === root.id) list.unshift(comment);
    else list.push(comment);
    threads.set(root.id, list);
  }

  const allThreads = [...threads.values()];
  const unresolvedCount = allThreads.filter((t) => !isResolved(rootOf(t[0]!, byId))).length;
  const pendingCount = comments.filter((c) => c.raw["pending"] === true).length;

  const selected = allThreads.filter((thread) => {
    const root = rootOf(thread[0]!, byId);
    if (bool(parsed, "--unresolved") && isResolved(root)) return false;
    if (paths.length > 0) {
      const path = str(dig(root.raw, "inline", "path"));
      if (!path || !matchesPath(path, paths)) return false;
    }
    return true;
  });

  if (selected.length === 0) {
    const what = bool(parsed, "--unresolved") ? "unresolved comment threads" : "comments";
    const scope = paths.length > 0 ? ` on ${paths.join(", ")}` : "";
    return out(
      block({ comments: `0 ${what}${scope} on pull request ${id} (${comments.length} comments total)` }),
      helpBlock(
        comments.length > 0 && (bool(parsed, "--unresolved") || paths.length > 0)
          ? [`Run \`bb-axi pr comments ${id}${hint}\` for all comments`]
          : [`Run \`bb-axi pr comment ${id} --body "<text>"${hint}\` to start the discussion`],
      ),
    );
  }

  let anyTruncated = false;
  const rows: Obj[] = [];
  for (const thread of selected) {
    const root = rootOf(thread[0]!, byId);
    for (const comment of thread) {
      const text = bool(parsed, "--full")
        ? { text: body(comment), truncated: false }
        : truncate(body(comment), COMMENT_BODY_LIMIT);
      anyTruncated ||= text.truncated;
      const isRoot = comment.id === root.id;
      const status = [
        isRoot ? (isResolved(root) ? "resolved" : "open") : "reply",
        comment.raw["pending"] === true ? "pending" : "",
        isRoot && dig(comment.raw, "inline", "outdated") === true ? "outdated" : "",
      ]
        .filter(Boolean)
        .join(" ");
      rows.push({
        id: comment.id,
        author: authorName(comment.raw, "user"),
        at: commentLocation(root.raw),
        reply_to: comment.parentId ?? null,
        status,
        age: relTime(comment.raw["created_on"]),
        body: text.text,
      });
    }
  }

  const help: string[] = [];
  if (anyTruncated) help.push(`Run \`bb-axi pr comments ${id} --full${hint}\` for untruncated bodies`);
  if (more) help.push(`Only the first ${limit} comments were read; raise \`--limit\` (max 500)`);
  help.push(`Reply: \`bb-axi pr comment ${id} --reply-to <comment-id> --body "<text>"${hint}\``);
  if (unresolvedCount > 0) help.push(`Resolve a thread: \`bb-axi pr resolve ${id} <comment-id>${hint}\``);

  return out(
    block({
      pr: id,
      count: `${comments.length}${more ? "+" : ""} comments / ${allThreads.length} threads / ${unresolvedCount} unresolved / ${pendingCount} pending`,
      comments: rows,
    }),
    helpBlock(help),
  );
}

export function readBody(parsed: ParsedArgs, usage: string): string {
  const inline = flag(parsed, "--body");
  const file = flag(parsed, "--body-file");
  if ((inline === undefined) === (file === undefined)) {
    throw usageError("provide exactly one of --body or --body-file", [usage]);
  }
  let text = inline;
  if (file !== undefined) {
    try {
      text = readFileSync(file === "-" ? 0 : file, "utf-8");
    } catch {
      throw usageError(`could not read --body-file ${file === "-" ? "(stdin)" : file}`);
    }
  }
  const trimmed = (text ?? "").trim();
  if (trimmed === "") throw usageError("comment body is empty", [usage]);
  return trimmed;
}

export async function prComment(args: string[], ctx: RepoContext): Promise<string> {
  const command = "bb-axi pr comment";
  const usage = `${command} <id> --body "<text>" [--path <file> --line <n> | --old-line <n>] [--reply-to <comment-id>] [--pending] | ${command} <id> --publish <comment-id>`;
  const parsed = parseArgs(
    args,
    [
      { name: "--body" },
      { name: "--body-file" },
      { name: "--path" },
      { name: "--line" },
      { name: "--old-line" },
      { name: "--reply-to" },
      { name: "--pending", boolean: true },
      { name: "--allow-duplicate", boolean: true },
      { name: "--publish" },
    ],
    command,
  );
  const [rawId] = expectPositionals(parsed, 1, usage);
  const id = positiveId(rawId, "pull request id");
  const publish = flag(parsed, "--publish");
  if (publish !== undefined) {
    const extra = ["--body", "--body-file", "--path", "--line", "--old-line", "--reply-to"].filter((f) => flag(parsed, f) !== undefined);
    if (bool(parsed, "--pending")) extra.push("--pending");
    if (extra.length > 0) throw usageError(`--publish takes no other comment flags (got ${extra.join(" ")})`, [usage]);
    return publishPending(ctx, id, positiveId(publish, "--publish"));
  }
  const text = readBody(parsed, usage);
  const path = flag(parsed, "--path");
  const line = flag(parsed, "--line");
  const oldLine = flag(parsed, "--old-line");
  const replyTo = flag(parsed, "--reply-to");
  const hint = repoHint(ctx);

  if (line !== undefined && oldLine !== undefined) {
    throw usageError("use either --line (new file line) or --old-line (removed line), not both");
  }
  if ((line !== undefined || oldLine !== undefined) && path === undefined) {
    throw usageError("--line/--old-line need --path <file>", [usage]);
  }
  if (replyTo !== undefined && path !== undefined) {
    throw usageError("--reply-to inherits the parent's location; do not combine it with --path");
  }

  const payload: Obj = { content: { raw: text } };
  if (path !== undefined) {
    const inline: Obj = { path };
    if (line !== undefined) inline["to"] = positiveId(line, "--line");
    if (oldLine !== undefined) inline["from"] = positiveId(oldLine, "--old-line");
    payload["inline"] = inline;
  }
  if (replyTo !== undefined) payload["parent"] = { id: positiveId(replyTo, "--reply-to") };
  if (bool(parsed, "--pending")) payload["pending"] = true;

  // Posting is not idempotent on the server, and an agent retrying after a
  // timeout would double-post. Treat an identical comment by the same user at
  // the same location as already done.
  if (!bool(parsed, "--allow-duplicate")) {
    const me = await currentUser();
    if (me) {
      const { comments } = await fetchComments(ctx, id, 500);
      const wantAt = commentLocation(payload);
      const parentId = replyTo !== undefined ? Number(replyTo) : undefined;
      const duplicate = comments.find(
        (c) =>
          str(dig(c.raw, "user", "uuid")) === me.uuid &&
          body(c).trim() === text &&
          c.parentId === parentId &&
          // Replies inherit the parent's inline location, so only top-level
          // comments are compared by location.
          (parentId !== undefined || commentLocation(c.raw) === wantAt),
      );
      if (duplicate) {
        return out(
          block({
            comment: {
              id: duplicate.id,
              pr: id,
              at: wantAt,
              result: "already posted (no-op)",
            },
          }),
          helpBlock([`Pass \`--allow-duplicate\` to post the same text again`]),
        );
      }
    }
  }

  const created = obj(await bbJson(`${prPath(ctx, id)}/comments`, { method: "POST", body: payload }));
  const pending = created["pending"] === true;
  const requestedPending = bool(parsed, "--pending");

  const help: string[] = [];
  if (requestedPending && pending) {
    help.push(`Pending comments are visible only to you; run \`bb-axi pr comment ${id} --publish ${num(created["id"]) ?? "<comment-id>"}${hint}\` to publish this one`);
  } else if (requestedPending && !pending) {
    help.push("Bitbucket did not keep this comment as pending - it is PUBLISHED and visible to everyone");
  }
  help.push(`Run \`bb-axi pr comments ${id}${hint}\` to see the thread`);

  return out(
    block({
      comment: {
        id: num(created["id"]) ?? null,
        pr: id,
        at: commentLocation(created["inline"] ? created : payload),
        result: pending ? "saved as pending (draft)" : "posted",
        url: str(dig(created, "links", "html", "href")),
      },
    }),
    helpBlock(help),
  );
}

/**
 * The public API cannot flip `pending` on an existing comment (PUT answers
 * "extra keys not allowed"), so publishing reposts the draft at the same
 * location and deletes the draft.
 */
async function publishPending(ctx: RepoContext, id: number, commentId: number): Promise<string> {
  const hint = repoHint(ctx);
  const draftPath = `${prPath(ctx, id)}/comments/${commentId}`;
  const draft = toComment(await bbJson(draftPath));
  const at = commentLocation(draft.raw);
  if (draft.raw["deleted"] === true) {
    throw axiError(`comment ${commentId} is deleted`, "NOT_FOUND", [`Run \`bb-axi pr comments ${id}${hint}\` to list the comments`]);
  }
  if (draft.raw["pending"] !== true) {
    return out(
      block({ comment: { id: commentId, pr: id, at, result: "already published (no-op)" } }),
      helpBlock([`Run \`bb-axi pr comments ${id}${hint}\` to see the thread`]),
    );
  }

  const payload: Obj = { content: { raw: body(draft) } };
  const inline = obj(draft.raw["inline"]);
  if (draft.parentId !== undefined) {
    payload["parent"] = { id: draft.parentId };
  } else if (str(inline["path"])) {
    const anchor: Obj = { path: str(inline["path"]) };
    if (num(inline["to"]) !== undefined) anchor["to"] = num(inline["to"]);
    if (num(inline["from"]) !== undefined) anchor["from"] = num(inline["from"]);
    payload["inline"] = anchor;
  }
  const created = obj(await bbJson(`${prPath(ctx, id)}/comments`, { method: "POST", body: payload }));
  const newId = num(created["id"]) ?? null;

  const help: string[] = [];
  let draftResult = "draft deleted";
  try {
    await bbJson(draftPath, { method: "DELETE" });
  } catch {
    draftResult = "draft NOT deleted";
    help.push(`Delete the leftover draft with \`bb-axi api DELETE /repositories/${ctx.slug}/pullrequests/${id}/comments/${commentId} --confirm\``);
  }
  help.push(`Run \`bb-axi pr comments ${id}${hint}\` to see the thread`);

  return out(
    block({
      comment: {
        id: newId,
        draft: commentId,
        pr: id,
        at,
        result: `published as a new comment - ${draftResult}`,
        url: str(dig(created, "links", "html", "href")),
      },
    }),
    helpBlock(help),
  );
}

/** resolve=true -> resolve the thread, resolve=false -> reopen it. Both idempotent. */
export async function prResolve(args: string[], ctx: RepoContext, resolve: boolean): Promise<string> {
  const command = `bb-axi pr ${resolve ? "resolve" : "unresolve"}`;
  const parsed = parseArgs(args, [], command);
  const [rawId, rawComment] = expectPositionals(parsed, 2, `${command} <id> <comment-id>`);
  const id = positiveId(rawId, "pull request id");
  const commentId = positiveId(rawComment, "comment id");
  const hint = repoHint(ctx);

  // Bitbucket resolves a thread through its root comment. Accept any comment
  // in the thread so an agent can pass the reply it just posted.
  const commentPath = (cid: number): string => `${prPath(ctx, id)}/comments/${cid}`;
  let root = toComment(await bbJson(commentPath(commentId)));
  const seen = new Set<number>();
  while (root.parentId !== undefined && !seen.has(root.id)) {
    seen.add(root.id);
    root = toComment(await bbJson(commentPath(root.parentId)));
  }
  if (root.raw["deleted"] === true) {
    throw axiError(`cannot ${resolve ? "resolve" : "reopen"} comment ${root.id}: it is deleted`, "CONFLICT");
  }

  const summary: Obj = { thread: root.id, pr: id, at: commentLocation(root.raw) };
  if (root.id !== commentId) summary["via"] = `reply ${commentId}`;
  if (isResolved(root) === resolve) {
    return block({ comment: { ...summary, result: resolve ? "already resolved (no-op)" : "already open (no-op)" } });
  }

  await bbJson(`${commentPath(root.id)}/resolve`, { method: resolve ? "POST" : "DELETE" });
  return out(
    block({ comment: { ...summary, result: resolve ? "resolved" : "reopened" } }),
    helpBlock(
      resolve
        ? [`Run \`bb-axi pr comments ${id} --unresolved${hint}\` for the threads still open`]
        : [`Reply: \`bb-axi pr comment ${id} --reply-to ${root.id} --body "<text>"${hint}\``],
    ),
  );
}
