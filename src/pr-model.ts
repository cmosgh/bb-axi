import type { Me } from "./me.js";
import { arr, dig, num, obj, str, type Obj } from "./render.js";

/** Ask list endpoints for the reviewer data they omit by default. */
export const PR_LIST_FIELDS = "+values.participants,+values.reviewers";

export interface ReviewerStatus {
  name: string;
  uuid: string;
  status: "approved" | "changes_requested" | "pending";
}

export function reviewers(pr: unknown): ReviewerStatus[] {
  const participants = arr(obj(pr)["participants"]).map(obj);
  const byUuid = new Map<string, Obj>();
  for (const p of participants) byUuid.set(str(dig(p, "user", "uuid")), p);

  const result: ReviewerStatus[] = [];
  const seen = new Set<string>();
  const push = (user: unknown, participant: Obj | undefined): void => {
    const uuid = str(obj(user)["uuid"]);
    if (seen.has(uuid)) return;
    seen.add(uuid);
    const state = str(participant?.["state"]);
    result.push({
      name: str(obj(user)["display_name"]) || str(obj(user)["nickname"]) || "unknown",
      uuid,
      status:
        state === "changes_requested"
          ? "changes_requested"
          : participant?.["approved"] === true || state === "approved"
            ? "approved"
            : "pending",
    });
  };

  for (const user of arr(obj(pr)["reviewers"])) {
    push(user, byUuid.get(str(obj(user)["uuid"])));
  }
  // Non-reviewer participants who approved or requested changes still count.
  for (const p of participants) {
    if (p["approved"] === true || str(p["state"]) === "changes_requested") {
      push(p["user"], p);
    }
  }
  return result;
}

export function isDraft(pr: unknown): boolean {
  return obj(pr)["draft"] === true;
}

/** Compact one-cell review summary for list rows. */
export function reviewSummary(pr: unknown, me: Me | undefined): string {
  const all = reviewers(pr);
  if (all.length === 0) return isDraft(pr) ? "draft" : "none";
  const approved = all.filter((r) => r.status === "approved").length;
  const parts = [`${approved}/${all.length} approved`];
  if (all.some((r) => r.status === "changes_requested")) parts.push("changes-requested");
  if (me && all.some((r) => r.uuid === me.uuid && r.status === "pending")) {
    parts.push("needs-you");
  }
  if (isDraft(pr)) parts.push("draft");
  return parts.join(" ");
}

export function myReviewStatus(pr: unknown, me: Me | undefined): ReviewerStatus["status"] | undefined {
  if (!me) return undefined;
  return reviewers(pr).find((r) => r.uuid === me.uuid)?.status;
}

export function isAuthor(pr: unknown, me: Me | undefined): boolean {
  return me !== undefined && str(dig(pr, "author", "uuid")) === me.uuid;
}

export function authorName(entity: unknown, key: "author" | "user" = "author"): string {
  const user = obj(obj(entity)[key]);
  return str(user["display_name"]) || str(user["nickname"]) || "unknown";
}

export function branches(pr: unknown): { source: string; dest: string } {
  return {
    source: str(dig(pr, "source", "branch", "name")) || "unknown",
    dest: str(dig(pr, "destination", "branch", "name")) || "unknown",
  };
}

/** "2/3 passed; 1 failed (lint)" from commit build statuses. */
export function buildsSummary(statuses: readonly unknown[]): string {
  if (statuses.length === 0) return "none";
  const states = statuses.map((s) => str(obj(s)["state"]));
  const passed = states.filter((s) => s === "SUCCESSFUL").length;
  const parts = [`${passed}/${statuses.length} passed`];
  const named = (state: string): string =>
    statuses
      .filter((s) => str(obj(s)["state"]) === state)
      .map((s) => str(obj(s)["name"]) || str(obj(s)["key"]))
      .filter(Boolean)
      .slice(0, 3)
      .join(" + ");
  const failed = states.filter((s) => s === "FAILED").length;
  if (failed > 0) parts.push(`${failed} failed (${named("FAILED")})`);
  const running = states.filter((s) => s === "INPROGRESS").length;
  if (running > 0) parts.push(`${running} in progress`);
  const stopped = states.filter((s) => s === "STOPPED").length;
  if (stopped > 0) parts.push(`${stopped} stopped`);
  // Semicolons, not commas: a comma would force TOON to quote the value.
  return parts.join("; ");
}

/**
 * Inline location in the same convention as the annotated diff:
 * `path:42` is NEW line 42, `path:-17` is OLD line 17.
 */
export function commentLocation(comment: unknown): string {
  const inline = obj(obj(comment)["inline"]);
  const path = str(inline["path"]);
  if (!path) return "general";
  const to = num(inline["to"]);
  const from = num(inline["from"]);
  if (to !== undefined) return `${path}:${to}`;
  if (from !== undefined) return `${path}:-${from}`;
  return path;
}

export function prState(pr: unknown): string {
  return str(obj(pr)["state"]).toLowerCase() || "unknown";
}
