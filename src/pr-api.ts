import { bbJson } from "./client.js";
import { repoPath, type RepoContext } from "./context.js";
import { obj, type Obj } from "./render.js";

export function prPath(ctx: RepoContext, id: number): string {
  return `${repoPath(ctx)}/pullrequests/${id}`;
}

export async function fetchPr(ctx: RepoContext, id: number): Promise<Obj> {
  return obj(await bbJson(prPath(ctx, id)));
}
