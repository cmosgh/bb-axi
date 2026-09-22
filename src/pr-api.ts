import { bbJson } from "./client.js";
import { repoPath, type RepoContext } from "./context.js";
import { obj, type Obj } from "./render.js";

export function prPath(ctx: RepoContext, id: number): string {
  return `${repoPath(ctx)}/pullrequests/${id}`;
}

export async function fetchPr(ctx: RepoContext, id: number): Promise<Obj> {
  return obj(await bbJson(prPath(ctx, id)));
}

export function bbqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * BBQL for a set of PR states. Needed because Bitbucket silently ignores the
 * `state` query parameter whenever `q` is present, so any filtered listing has
 * to carry its own state clause.
 */
export function stateClause(states: readonly string[]): string {
  const ors = states.map((state) => `state=${bbqlString(state)}`).join(" OR ");
  return states.length > 1 ? `(${ors})` : ors;
}
