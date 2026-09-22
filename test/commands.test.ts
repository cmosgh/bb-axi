import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANA, BASE, BOB, ME, mockApi, pr, REPO, run, useTestEnv } from "./helpers.js";

beforeEach(() => useTestEnv());
afterEach(() => vi.unstubAllGlobals());

const page = (values: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  values,
  size: values.length,
  ...extra,
});

describe("pr list", () => {
  it("queries open PRs with reviewer fields and renders compact rows", async () => {
    const { calls } = mockApi([{ path: `${BASE}/pullrequests`, json: page([pr(), pr({ id: 43, title: "Other" })], { size: 14 }) }]);
    const { stdout, exitCode } = await run("pr", "list", ...REPO);
    expect(exitCode).toBe(0);
    const list = calls.find((c) => c.path === `${BASE}/pullrequests`)!;
    expect(list.url.searchParams.getAll("state")).toEqual(["OPEN"]);
    expect(list.url.searchParams.get("q")).toBeNull();
    expect(list.url.searchParams.get("fields")).toBe("+values.participants,+values.reviewers");
    expect(list.headers["Authorization"]).toMatch(/^Basic /);
    expect(list.headers["User-Agent"]).toMatch(/^bb-axi\/\d/);
    expect(stdout).toContain("count: 2 of 14 total");
    expect(stdout).toContain("prs[2]{id,title,author,review}:");
    expect(stdout).toContain("42,Add retry to the sync worker,Ana Author,1/2 approved needs-you");
    // explicit -R is carried into the suggestion
    expect(stdout).toContain("bb-axi pr view <id> -R acme/widgets");
  });

  it("filters by the current user and escapes BBQL strings", async () => {
    const { calls } = mockApi([{ path: `${BASE}/pullrequests`, json: page([]) }]);
    const { stdout } = await run("pr", "list", "--reviewing", "--source", 'we"ird', ...REPO);
    const q = calls.find((c) => c.path === `${BASE}/pullrequests`)!.url.searchParams.get("q");
    expect(q).toBe(`state="OPEN" AND reviewers.uuid="${ME.uuid}" AND source.branch.name="we\\"ird"`);
    expect(stdout).toContain("prs: 0 open pull requests awaiting your review in acme/widgets");
  });

  it("--state all sends every state as a repeated parameter", async () => {
    const { calls } = mockApi([{ path: `${BASE}/pullrequests`, json: page([pr({ state: "MERGED" })]) }]);
    await run("pr", "list", "--state", "all", ...REPO);
    const list = calls.find((c) => c.path === `${BASE}/pullrequests`)!;
    expect(list.url.searchParams.getAll("state")).toEqual(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]);
    expect(list.url.searchParams.get("q")).toBeNull();
  });

  // Bitbucket ignores the `state` parameter as soon as `q` is present, so a
  // filtered listing has to repeat the state inside the BBQL or it silently
  // returns every state.
  it("repeats the state inside BBQL when --query is combined with --state", async () => {
    const { calls } = mockApi([{ path: `${BASE}/pullrequests`, json: page([]) }]);
    await run("pr", "list", "--state", "declined", "--query", 'source.branch.name~"wf/"', ...REPO);
    const list = calls.find((c) => c.path === `${BASE}/pullrequests`)!;
    expect(list.url.searchParams.getAll("state")).toEqual(["DECLINED"]);
    expect(list.url.searchParams.get("q")).toBe('state="DECLINED" AND (source.branch.name~"wf/")');
  });

  it("--fields state carries each row's disposition", async () => {
    mockApi([
      {
        path: `${BASE}/pullrequests`,
        json: page([pr({ state: "MERGED" }), pr({ id: 43, title: "Other", state: "DECLINED" })]),
      },
    ]);
    const { stdout } = await run("pr", "list", "--state", "all", "--fields", "state", ...REPO);
    expect(stdout).toContain("prs[2]{id,title,author,review,state}:");
    expect(stdout).toContain(",merged");
    expect(stdout).toContain(",declined");
  });

  it("repeats every state inside BBQL for --state all with a filter", async () => {
    const { calls } = mockApi([{ path: `${BASE}/pullrequests`, json: page([]) }]);
    await run("pr", "list", "--state", "all", "--source", "feature/x", ...REPO);
    const q = calls.find((c) => c.path === `${BASE}/pullrequests`)!.url.searchParams.get("q");
    expect(q).toBe(
      '(state="OPEN" OR state="MERGED" OR state="DECLINED" OR state="SUPERSEDED") AND source.branch.name="feature/x"',
    );
  });

  it("follows pagination but refuses to send credentials to another origin", async () => {
    mockApi([
      {
        path: `${BASE}/pullrequests`,
        json: { values: [pr()], next: "https://evil.example/2.0/steal" },
      },
    ]);
    const { stdout, exitCode } = await run("pr", "list", "--limit", "100", ...REPO);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("refusing to send credentials to https://evil.example");
  });
});

describe("pr view", () => {
  it("aggregates reviewers, builds and counts into one call's worth of output", async () => {
    mockApi([
      { path: `${BASE}/pullrequests/42`, json: pr() },
      {
        path: `${BASE}/pullrequests/42/statuses`,
        json: page([
          { state: "SUCCESSFUL", name: "unit" },
          { state: "FAILED", name: "lint" },
        ]),
      },
    ]);
    const { stdout } = await run("pr", "view", "42", ...REPO);
    expect(stdout).toContain("branch: feature/retry -> develop");
    expect(stdout).toContain("review: 1/2 approved needs-you");
    expect(stdout).toContain("builds: 1/2 passed; 1 failed (lint)");
    expect(stdout).toContain("Robin Reviewer (you),pending");
    expect(stdout).toContain("Bob Builder,approved");
    expect(stdout).toContain("bb-axi pr approve 42 -R acme/widgets");
  });

  it("truncates long descriptions with a --full escape hatch, and still renders when statuses fail", async () => {
    mockApi([
      { path: `${BASE}/pullrequests/42`, json: pr({ description: "word ".repeat(600) }) },
      { path: `${BASE}/pullrequests/42/statuses`, status: 500, json: { error: { message: "boom" } } },
    ]);
    const { stdout, exitCode } = await run("pr", "view", "42", ...REPO);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("(truncated, 3000 chars total)");
    expect(stdout).toContain("bb-axi pr view 42 --full");
    expect(stdout).toContain("builds: unavailable");
  });

  it("maps API failures to structured errors", async () => {
    mockApi([{ path: `${BASE}/pullrequests/999`, status: 404, json: { error: { message: "No such pull request" } } }]);
    const notFound = await run("pr", "view", "999", ...REPO);
    expect(notFound.exitCode).toBe(1);
    expect(notFound.stdout).toContain("code: NOT_FOUND");
    expect(notFound.stdout).toContain("No such pull request");

    mockApi([{ path: `${BASE}/pullrequests/42`, status: 401 }]);
    const unauthorized = await run("pr", "view", "42", ...REPO);
    expect(unauthorized.stdout).toContain("code: AUTH_REQUIRED");
    expect(unauthorized.stdout).toContain("bb-axi auth login");
  });
});

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
 export { a };
diff --git a/yarn.lock b/yarn.lock
--- a/yarn.lock
+++ b/yarn.lock
@@ -1,1 +1,1 @@
-x
+y
`;

const DIFFSTAT = page([
  { status: "modified", new: { path: "src/a.ts" }, old: { path: "src/a.ts" }, lines_added: 1, lines_removed: 1 },
  { status: "modified", new: { path: "yarn.lock" }, old: { path: "yarn.lock" }, lines_added: 1, lines_removed: 1 },
]);

describe("pr diff", () => {
  it("prints a file table, an annotated diff, and elides lockfiles", async () => {
    mockApi([
      { path: `${BASE}/pullrequests/42/diffstat`, json: DIFFSTAT },
      { path: `${BASE}/pullrequests/42/diff`, text: DIFF },
    ]);
    const { stdout } = await run("pr", "diff", "42", ...REPO);
    expect(stdout).toContain("files_changed: 2");
    expect(stdout).toContain("lines: +2 -2");
    expect(stdout).toContain("src/a.ts,modified,1,1");
    expect(stdout).toContain("== src/a.ts");
    expect(stdout).toContain("   1 -const a = 1;");
    expect(stdout).toContain("   1 +const a = 2;");
    expect(stdout).toContain("   2  export { a };");
    expect(stdout).not.toContain("== yarn.lock");
    expect(stdout).toContain("elided_generated[1]: yarn.lock");
    expect(stdout).toContain("--old-line <n>");
  });

  it("--stat skips the diff request entirely", async () => {
    const { calls } = mockApi([{ path: `${BASE}/pullrequests/42/diffstat`, json: DIFFSTAT }]);
    const { stdout } = await run("pr", "diff", "42", "--stat", ...REPO);
    expect(calls.some((c) => c.path.endsWith("/diff"))).toBe(false);
    expect(stdout).toContain("files[2]{path,status,added,removed}:");
  });

  it("gives a definitive empty state when --path matches nothing", async () => {
    mockApi([
      { path: `${BASE}/pullrequests/42/diffstat`, json: DIFFSTAT },
      { path: `${BASE}/pullrequests/42/diff`, text: DIFF },
    ]);
    const { stdout } = await run("pr", "diff", "42", "--path", "docs/", ...REPO);
    expect(stdout).toContain("0 of 2 changed files match docs/");
  });
});

const COMMENTS = page([
  {
    id: 1,
    content: { raw: "Guard the null case" },
    user: BOB,
    inline: { path: "src/a.ts", to: 12 },
    created_on: new Date(Date.now() - 7_200_000).toISOString(),
  },
  { id: 2, content: { raw: "General note" }, user: ANA, resolution: { type: "resolved" }, created_on: new Date().toISOString() },
  { id: 3, content: { raw: "Done" }, user: ANA, parent: { id: 1 }, inline: { path: "src/a.ts", to: 12 }, created_on: new Date().toISOString() },
  { id: 4, content: { raw: "deleted" }, user: ANA, deleted: true },
]);

describe("pr comments", () => {
  it("threads replies under their root and pre-computes thread counts", async () => {
    mockApi([{ path: `${BASE}/pullrequests/42/comments`, json: COMMENTS }]);
    const { stdout } = await run("pr", "comments", "42", ...REPO);
    expect(stdout).toContain("count: 3 comments / 2 threads / 1 unresolved / 0 pending");
    const rows = stdout.split("\n").filter((l) => /^\s+\d+,/.test(l));
    expect(rows.map((r) => r.trim().split(",")[0])).toEqual(["1", "3", "2"]);
    expect(rows[0]).toContain('"src/a.ts:12",null,open');
    expect(rows[1]).toContain('"src/a.ts:12",1,reply');
    expect(rows[2]).toContain("general,null,resolved");
    expect(stdout).not.toContain("deleted");
  });

  it("--unresolved filters whole threads", async () => {
    mockApi([{ path: `${BASE}/pullrequests/42/comments`, json: COMMENTS }]);
    const { stdout } = await run("pr", "comments", "42", "--unresolved", ...REPO);
    expect(stdout).toContain("Guard the null case");
    expect(stdout).not.toContain("General note");
  });
});

describe("pr comment", () => {
  it("posts an inline pending comment with the right payload", async () => {
    const { calls } = mockApi([
      { path: `${BASE}/pullrequests/42/comments`, json: page([]) },
      {
        method: "POST",
        path: `${BASE}/pullrequests/42/comments`,
        status: 201,
        reply: (call) => ({ json: { id: 77, pending: true, ...(call.body as object) } }),
      },
    ]);
    const { stdout } = await run(
      "pr", "comment", "42", "--path", "src/a.ts", "--line", "12", "--body", "Guard the null case", "--pending", ...REPO,
    );
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({
      content: { raw: "Guard the null case" },
      inline: { path: "src/a.ts", to: 12 },
      pending: true,
    });
    expect(stdout).toContain("result: saved as pending (draft)");
    expect(stdout).toContain("at: \"src/a.ts:12\"");
  });

  it("uses `from` for --old-line and `parent` for replies", async () => {
    const { calls } = mockApi([
      { path: `${BASE}/pullrequests/42/comments`, json: page([]) },
      { method: "POST", path: `${BASE}/pullrequests/42/comments`, reply: (c) => ({ json: { id: 78, ...(c.body as object) } }) },
    ]);
    await run("pr", "comment", "42", "--path", "src/a.ts", "--old-line", "9", "--body", "Why removed?", ...REPO);
    await run("pr", "comment", "42", "--reply-to", "1", "--body", "Agreed", ...REPO);
    const posts = calls.filter((c) => c.method === "POST").map((c) => c.body);
    expect(posts[0]).toMatchObject({ inline: { path: "src/a.ts", from: 9 } });
    expect(posts[1]).toEqual({ content: { raw: "Agreed" }, parent: { id: 1 } });
  });

  it("is idempotent: an identical comment by the same user is a no-op", async () => {
    const { calls } = mockApi([
      {
        path: `${BASE}/pullrequests/42/comments`,
        json: page([{ id: 5, content: { raw: "Guard the null case" }, user: ME, inline: { path: "src/a.ts", to: 12 } }]),
      },
    ]);
    const { stdout, exitCode } = await run(
      "pr", "comment", "42", "--path", "src/a.ts", "--line", "12", "--body", "Guard the null case", ...REPO,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("already posted (no-op)");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("warns loudly when Bitbucket publishes a comment that was requested as pending", async () => {
    mockApi([
      { path: `${BASE}/pullrequests/42/comments`, json: page([]) },
      { method: "POST", path: `${BASE}/pullrequests/42/comments`, json: { id: 79, pending: false } },
    ]);
    const { stdout } = await run("pr", "comment", "42", "--body", "Looks good", "--pending", ...REPO);
    expect(stdout).toContain("it is PUBLISHED and visible to everyone");
  });

  it("validates flag combinations before any network call", async () => {
    const { calls } = mockApi([]);
    const noPath = await run("pr", "comment", "42", "--line", "3", "--body", "x", ...REPO);
    expect(noPath.exitCode).toBe(2);
    expect(noPath.stdout).toContain("--line/--old-line need --path");
    const noBody = await run("pr", "comment", "42", ...REPO);
    expect(noBody.stdout).toContain("exactly one of --body or --body-file");
    expect(calls).toHaveLength(0);
  });
});

describe("review actions", () => {
  it("approve is a no-op when already approved, and posts otherwise", async () => {
    const approved = pr({
      participants: [{ user: ME, role: "REVIEWER", approved: true, state: "approved" }],
      reviewers: [ME],
    });
    let api = mockApi([{ path: `${BASE}/pullrequests/42`, json: approved }]);
    const noop = await run("pr", "approve", "42", ...REPO);
    expect(noop.stdout).toContain("already approved by you (no-op)");
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);

    api = mockApi([
      { path: `${BASE}/pullrequests/42`, json: pr() },
      { method: "POST", path: `${BASE}/pullrequests/42/approve`, json: { approved: true } },
    ]);
    const done = await run("pr", "approve", "42", ...REPO);
    expect(done.stdout).toContain("result: approved");
    expect(api.calls.some((c) => c.method === "POST" && c.path.endsWith("/approve"))).toBe(true);
  });

  it("refuses to approve your own or a closed PR", async () => {
    mockApi([{ path: `${BASE}/pullrequests/42`, json: pr({ author: ME, reviewers: [], participants: [] }) }]);
    expect((await run("pr", "approve", "42", ...REPO)).stdout).toContain("you are its author");
    mockApi([{ path: `${BASE}/pullrequests/42`, json: pr({ state: "MERGED" }) }]);
    expect((await run("pr", "approve", "42", ...REPO)).stdout).toContain("it is merged");
  });

  it("merge previews without --confirm and merges with it", async () => {
    let api = mockApi([
      { path: `${BASE}/pullrequests/42`, json: pr() },
      { path: `${BASE}/pullrequests/42/statuses`, json: page([{ state: "SUCCESSFUL", name: "unit" }]) },
    ]);
    const preview = await run("pr", "merge", "42", "--strategy", "squash", ...REPO);
    expect(preview.stdout).toContain("NOT merged - preview only");
    expect(preview.stdout).toContain("bb-axi pr merge 42 --confirm --strategy squash -R acme/widgets");
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);

    api = mockApi([
      { path: `${BASE}/pullrequests/42`, json: pr() },
      { method: "POST", path: `${BASE}/pullrequests/42/merge`, json: pr({ state: "MERGED", merge_commit: { hash: "abcdef1234567890" } }) },
    ]);
    const merged = await run("pr", "merge", "42", "--confirm", "--strategy", "squash", ...REPO);
    expect(merged.stdout).toContain("result: merged");
    expect(api.calls.find((c) => c.method === "POST")!.body).toEqual({ merge_strategy: "squash" });
  });

  it("create is idempotent per source branch", async () => {
    const { calls } = mockApi([{ path: `${BASE}/pullrequests`, json: page([pr()]) }]);
    const { stdout } = await run("pr", "create", "--title", "Again", "--source", "feature/retry", ...REPO);
    expect(stdout).toContain("already open for this branch (no-op)");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    // the guard must be OPEN-scoped in the BBQL: the `state` parameter alone is
    // ignored once `q` is present, and a merged PR on a reused branch name
    // would then block the create forever.
    const lookup = calls.find((c) => c.path === `${BASE}/pullrequests` && c.method === "GET")!;
    expect(lookup.url.searchParams.get("q")).toBe(
      'state="OPEN" AND source.branch.name="feature/retry"',
    );
  });

  it("create adds default reviewers but never the author", async () => {
    const { calls } = mockApi([
      { path: `${BASE}/pullrequests`, json: page([]) },
      { path: `${BASE}/effective-default-reviewers`, json: page([{ user: ME }, { user: BOB }]) },
      { method: "POST", path: `${BASE}/pullrequests`, status: 201, reply: (c) => ({ json: { ...pr(), ...(c.body as object), id: 50 } }) },
    ]);
    const { stdout } = await run(
      "pr", "create", "--title", "New", "--source", "feature/x", "--dest", "develop", "--default-reviewers", ...REPO,
    );
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({
      title: "New",
      source: { branch: { name: "feature/x" } },
      destination: { branch: { name: "develop" } },
      reviewers: [{ uuid: BOB.uuid }],
    });
    expect(stdout).toContain("result: created");
  });
});

describe("api escape hatch", () => {
  it("fills {workspace}/{repo}, drops links and gates DELETE behind --confirm", async () => {
    const { calls } = mockApi([
      { path: `${BASE}/refs/branches`, json: { values: [{ name: "main", links: { self: { href: "x" } } }] } },
    ]);
    const get = await run("api", "/repositories/{workspace}/{repo}/refs/branches", "--query", "pagelen=5", ...REPO);
    expect(calls[0]!.url.searchParams.get("pagelen")).toBe("5");
    expect(get.stdout).toContain("main");
    expect(get.stdout).not.toContain("links");

    const del = await run("api", "DELETE", "/repositories/{workspace}/{repo}/refs/branches/x", ...REPO);
    expect(del.stdout).toContain("NOT executed - DELETE needs --confirm");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("pipelines", () => {
  const pipeline = {
    uuid: "{pipe-1}",
    build_number: 1284,
    state: { name: "COMPLETED", result: { name: "FAILED" } },
    target: { ref_name: "develop", commit: { hash: "0123456789abcdef" } },
    trigger: { name: "PUSH" },
    creator: ANA,
    duration_in_seconds: 187,
    created_on: new Date(Date.now() - 3_600_000).toISOString(),
  };

  it("lists runs with a collapsed status", async () => {
    mockApi([{ path: `${BASE}/pipelines`, json: page([pipeline]) }]);
    const { stdout } = await run("pipeline", "list", ...REPO);
    expect(stdout).toContain("pipelines[1]{build,status,ref,age}:");
    expect(stdout).toContain("1284,failed,develop,1h ago");
    expect(stdout).toContain("bb-axi pipeline log <build-number>");
  });

  it("log picks the first failed step and tails it", async () => {
    mockApi([
      { path: `${BASE}/pipelines`, json: page([pipeline]) },
      {
        path: `${BASE}/pipelines/%7Bpipe-1%7D/steps`,
        json: page([
          { uuid: "{s1}", name: "build", state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } } },
          { uuid: "{s2}", name: "test", state: { name: "COMPLETED", result: { name: "FAILED" } } },
        ]),
      },
      { path: `${BASE}/pipelines/%7Bpipe-1%7D/steps/%7Bs2%7D/log`, text: `${"noise\n".repeat(3000)}AssertionError: expected 1 to be 2\n` },
    ]);
    const { stdout } = await run("pipeline", "log", "1284", ...REPO);
    expect(stdout).toContain("step: 2/2 test");
    expect(stdout).toContain("AssertionError: expected 1 to be 2");
    expect(stdout).toContain("truncated, showing last");
    expect(stdout).toContain("bb-axi pipeline log 1284 --step 2 --full");
  });
});

describe("home dashboard", () => {
  it("makes no network calls outside a Bitbucket checkout", async () => {
    const { calls } = mockApi([]);
    const cwd = process.cwd();
    process.chdir("/");
    try {
      const { stdout } = await run();
      expect(stdout).toContain("repo: none - not inside a Bitbucket checkout");
      expect(stdout).toMatch(/^bin: /);
      expect(calls).toHaveLength(0);
    } finally {
      process.chdir(cwd);
    }
  });

  it("splits open PRs into 'needs your review' and 'yours' from a single list call", async () => {
    process.env["BB_AXI_REPO"] = "acme/widgets";
    const { calls } = mockApi([
      {
        path: `${BASE}/pullrequests`,
        json: page([pr(), pr({ id: 7, title: "My change", author: ME, reviewers: [BOB], participants: [] })], { size: 9 }),
      },
    ]);
    const { stdout } = await run();
    expect(stdout).toContain("repo: acme/widgets");
    expect(stdout).toContain("open_prs: 9");
    expect(stdout).toContain("needs_your_review[1]{id,title,author,updated}:");
    expect(stdout).toContain("your_prs[1]{id,title,review,updated}:");
    expect(calls.filter((c) => c.path === `${BASE}/pullrequests`)).toHaveLength(1);
  });

  it("degrades to one line when the API is unreachable", async () => {
    process.env["BB_AXI_REPO"] = "acme/widgets";
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const { stdout, exitCode } = await run();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("prs: unavailable - could not reach the Bitbucket API");
  });
});

describe("cli surface", () => {
  it("rejects unknown commands and subcommands with exit code 2", async () => {
    mockApi([]);
    const unknown = await run("frobnicate");
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stdout).toContain("commands: pr, pipeline, repo, api, auth, setup");
    const sub = await run("pr", "frob", ...REPO);
    expect(sub.exitCode).toBe(2);
    expect(sub.stdout).toContain("unknown pr subcommand 'frob'");
  });

  it("serves per-command help without touching the network", async () => {
    const { calls } = mockApi([]);
    const { stdout } = await run("pr", "--help");
    expect(stdout).toContain("flags{diff}:");
    expect(calls).toHaveLength(0);
  });

  it("reports missing credentials with an actionable, non-interactive fix", async () => {
    delete process.env["BITBUCKET_EMAIL"];
    delete process.env["BITBUCKET_API_TOKEN"];
    mockApi([]);
    const { stdout, exitCode } = await run("pr", "list", ...REPO);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: AUTH_REQUIRED");
    expect(stdout).toContain("--token-stdin");
  });
});
