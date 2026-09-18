import { execFileSync } from "node:child_process";
import { axiError, usageError } from "./errors.js";

export interface RepoContext {
  workspace: string;
  repo: string;
  /** "workspace/repo" */
  slug: string;
  /** How the repo was resolved; flag/env sources are carried into suggestions. */
  source: "flag" | "env" | "git";
}

function parseSlug(value: string, source: "flag" | "env"): RepoContext {
  const parts = value.trim().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw usageError(`invalid repository '${value}' - expected <workspace>/<repo>`);
  }
  return { workspace: parts[0], repo: parts[1], slug: `${parts[0]}/${parts[1]}`, source };
}

/**
 * Parse a Bitbucket remote. Covers scp-style SSH, ssh://, https:// (with or
 * without a user), and SSH host aliases such as `git@bitbucket-work:ws/repo`
 * that people with several accounts define in ~/.ssh/config.
 */
export function parseRemoteUrl(url: string): RepoContext | undefined {
  const match =
    // ssh://[user@]host[:port]/ws/repo(.git) and https://[user@]host/ws/repo(.git)
    url.match(
      /^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    ) ??
    // scp-style: [user@]host:ws/repo(.git)
    url.match(/^(?:[^@/]+@)?([^:/]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) return undefined;
  const [, host, workspace, repo] = match;
  if (!host || !workspace || !repo || !host.toLowerCase().includes("bitbucket")) {
    return undefined;
  }
  return { workspace, repo, slug: `${workspace}/${repo}`, source: "git" };
}

function gitRemotes(): string[] {
  try {
    const output = execFileSync("git", ["remote", "-v"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    const lines = output.split("\n").filter((line) => line.includes("(fetch)"));
    // origin first, then the rest in declaration order
    lines.sort((a, b) => Number(b.startsWith("origin\t")) - Number(a.startsWith("origin\t")));
    return lines.map((line) => line.split(/\s+/)[1] ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

/** Priority: -R/--repo flag > BB_AXI_REPO env > Bitbucket git remote of the cwd. */
export function resolveRepo(flagValue?: string): RepoContext | undefined {
  if (flagValue !== undefined) return parseSlug(flagValue, "flag");
  const env = process.env["BB_AXI_REPO"];
  if (env) return parseSlug(env, "env");
  for (const url of gitRemotes()) {
    const ctx = parseRemoteUrl(url);
    if (ctx) return ctx;
  }
  return undefined;
}

export function requireRepo(ctx: RepoContext | undefined): RepoContext {
  if (!ctx) {
    throw axiError("no Bitbucket repository in context", "REPO_REQUIRED", [
      "Pass `-R <workspace>/<repo>` after the command, or run from a checkout with a bitbucket.org remote",
    ]);
  }
  return ctx;
}

export function repoPath(ctx: RepoContext): string {
  return `/repositories/${encodeURIComponent(ctx.workspace)}/${encodeURIComponent(ctx.repo)}`;
}

/** Suffix for suggested commands so they keep targeting an explicit repo. */
export function repoHint(ctx: RepoContext | undefined): string {
  return ctx && ctx.source === "flag" ? ` -R ${ctx.slug}` : "";
}

export function currentBranch(): string | undefined {
  try {
    const name = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return name && name !== "HEAD" ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Split `-R/--repo` out of the args so command parsers never see it. */
export function splitRepoFlag(args: string[]): { repoFlag: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let repoFlag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === "--") {
      rest.push(...args.slice(i));
      break;
    }
    if (token === "-R" || token === "--repo") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw usageError(`${token} requires a value`, ["-R <workspace>/<repo>"]);
      }
      repoFlag = value;
      i++;
      continue;
    }
    if (token.startsWith("--repo=") || token.startsWith("-R=")) {
      repoFlag = token.slice(token.indexOf("=") + 1);
      continue;
    }
    rest.push(token);
  }
  return { repoFlag, rest };
}
