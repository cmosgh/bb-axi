import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bool, flag, flags, parseArgs, parseFields, positiveId } from "../src/args.js";
import { parseRemoteUrl, splitRepoFlag } from "../src/context.js";
import { annotate, isNoiseFile, matchesPath, selectDiff, splitFiles } from "../src/diff.js";
import { buildsSummary, commentLocation, reviewSummary, reviewers } from "../src/pr-model.js";
import { countLine, relTime, truncate, truncateTail } from "../src/render.js";
import { ANA, BOB, ME, pr } from "./helpers.js";

const SPECS = [
  { name: "--state" },
  { name: "--full", boolean: true },
  { name: "--path", repeatable: true },
  { name: "--dest" },
  { name: "--body" },
];

describe("parseArgs", () => {
  it("parses space and equals forms, booleans, repeatables and positionals", () => {
    const parsed = parseArgs(["42", "--state", "open", "--path=a", "--path", "b", "--full"], SPECS, "x");
    expect(parsed.positionals).toEqual(["42"]);
    expect(flag(parsed, "--state")).toBe("open");
    expect(flags(parsed, "--path")).toEqual(["a", "b"]);
    expect(bool(parsed, "--full")).toBe(true);
  });

  it("fails loud on unknown flags and lists the valid ones", () => {
    expect(() => parseArgs(["--stat", "closed"], SPECS, "bb-axi pr list")).toThrowError(/unknown flag --stat/);
    try {
      parseArgs(["--stat"], SPECS, "bb-axi pr list");
    } catch (error) {
      expect((error as { suggestions: string[] }).suggestions.join(" ")).toContain("--state, --full, --path");
    }
  });

  it("gives a targeted hint for flags carried over from other CLIs", () => {
    try {
      parseArgs(["--base", "main"], SPECS, "bb-axi pr create");
      expect.unreachable();
    } catch (error) {
      expect((error as { suggestions: string[] }).suggestions[0]).toBe(
        "--base is not supported here; use --dest instead",
      );
    }
  });

  it("treats a following declared flag as a missing value but accepts dash-leading text", () => {
    expect(() => parseArgs(["--state", "--full"], SPECS, "x")).toThrowError(/--state requires a value/);
    expect(flag(parseArgs(["--body", "- a bullet"], SPECS, "x"), "--body")).toBe("- a bullet");
  });

  it("rejects repeats of single-value flags and values on booleans", () => {
    expect(() => parseArgs(["--state", "a", "--state", "b"], SPECS, "x")).toThrowError(/only be given once/);
    expect(() => parseArgs(["--full=yes"], SPECS, "x")).toThrowError(/does not take a value/);
  });

  it("stops flag parsing at --", () => {
    expect(parseArgs(["--", "--not-a-flag"], SPECS, "x").positionals).toEqual(["--not-a-flag"]);
  });

  it("validates ids and --fields", () => {
    expect(positiveId("#42", "id")).toBe(42);
    expect(() => positiveId("abc", "id")).toThrowError(/invalid id/);
    expect(parseFields("a, b,a", ["a", "b"])).toEqual(["a", "b"]);
    expect(() => parseFields("zzz", ["a"])).toThrowError(/unknown field: zzz/);
  });
});

describe("repository context", () => {
  it.each([
    ["git@bitbucket.org:acme/widgets.git", "acme/widgets"],
    ["https://robin@bitbucket.org/acme/widgets.git", "acme/widgets"],
    ["https://bitbucket.org/acme/widgets", "acme/widgets"],
    ["ssh://git@bitbucket.org/acme/widgets.git", "acme/widgets"],
    ["ssh://git@bitbucket.org:22/acme/widgets.git", "acme/widgets"],
    ["git@bitbucket-work:acme/widgets.git", "acme/widgets"],
  ])("parses %s", (url, slug) => {
    expect(parseRemoteUrl(url)?.slug).toBe(slug);
  });

  it("ignores non-Bitbucket remotes", () => {
    expect(parseRemoteUrl("git@github.com:acme/widgets.git")).toBeUndefined();
  });

  it("splits -R/--repo out of the args", () => {
    expect(splitRepoFlag(["list", "-R", "a/b", "--full"])).toEqual({ repoFlag: "a/b", rest: ["list", "--full"] });
    expect(splitRepoFlag(["--repo=a/b", "list"])).toEqual({ repoFlag: "a/b", rest: ["list"] });
    expect(() => splitRepoFlag(["list", "-R"])).toThrowError(/requires a value/);
  });
});

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,5 +10,6 @@ export function sync() {
   const a = 1;
-  const b = 2;
+  const b = 3;
+  const c = 4;

   return a;
@@ -40,2 +41,2 @@
-old tail
+new tail
 same
\\ No newline at end of file
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1,1 +1,1 @@
-lock: 1
+lock: 2
diff --git a/old/name.ts b/new/name.ts
similarity index 100%
rename from old/name.ts
rename to new/name.ts
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`;

describe("diff", () => {
  it("splits files and resolves paths for edits, renames and deletions", () => {
    const files = splitFiles(DIFF);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "pnpm-lock.yaml", "new/name.ts", "gone.ts"]);
    expect(files[2]?.oldPath).toBe("old/name.ts");
  });

  it("annotates '-' lines with OLD numbers and everything else with NEW numbers", () => {
    const text = annotate(splitFiles(DIFF)[0]!);
    const lines = text.split("\n");
    expect(lines[0]).toBe("== src/a.ts");
    expect(lines).toContain("  10    const a = 1;");
    expect(lines).toContain("  11 -  const b = 2;");
    expect(lines).toContain("  11 +  const b = 3;");
    expect(lines).toContain("  12 +  const c = 4;");
    // blank context line inside the hunk keeps the numbering aligned
    expect(lines).toContain("  14    return a;");
    // second hunk restarts from its header
    expect(lines).toContain("  40 -old tail");
    expect(lines).toContain("  41 +new tail");
    expect(lines).toContain("  42  same");
    expect(lines).toContain("\\ No newline at end of file");
    expect(text).not.toContain("index 1111111");
  });

  it("matches exact paths, directories and globs", () => {
    expect(matchesPath("src/a.ts", [])).toBe(true);
    expect(matchesPath("src/a.ts", ["src/a.ts"])).toBe(true);
    expect(matchesPath("src/a.ts", ["src"])).toBe(true);
    expect(matchesPath("src/a.ts", ["src/"])).toBe(true);
    expect(matchesPath("src2/a.ts", ["src"])).toBe(false);
    expect(matchesPath("src/deep/a.spec.ts", ["*.spec.ts"])).toBe(true);
    expect(matchesPath("src/a.ts", ["*.spec.ts"])).toBe(false);
  });

  it("elides lockfiles by default but shows them when asked for", () => {
    expect(isNoiseFile("web/package-lock.json")).toBe(true);
    expect(isNoiseFile("src/lock.ts")).toBe(false);
    const byDefault = selectDiff(DIFF, { paths: [], full: false, annotate: true, budget: 10_000 });
    expect(byDefault.elided).toEqual(["pnpm-lock.yaml"]);
    expect(byDefault.shown).toEqual(["src/a.ts", "new/name.ts", "gone.ts"]);
    const explicit = selectDiff(DIFF, { paths: ["pnpm-lock.yaml"], full: false, annotate: true, budget: 10_000 });
    expect(explicit.shown).toEqual(["pnpm-lock.yaml"]);
    expect(selectDiff(DIFF, { paths: [], full: true, annotate: true, budget: 1 }).shown).toHaveLength(4);
  });

  it("respects the budget at file boundaries and cuts a single oversized file", () => {
    const tight = selectDiff(DIFF, { paths: [], full: false, annotate: true, budget: 320 });
    expect(tight.shown).toEqual(["src/a.ts"]);
    expect(tight.overBudget).toEqual(["new/name.ts", "gone.ts"]);
    const tiny = selectDiff(DIFF, { paths: [], full: false, annotate: true, budget: 60 });
    expect(tiny.cutFile).toBe("src/a.ts");
    expect(tiny.body).toContain("truncated");
  });
});

describe("pr model", () => {
  it("summarises reviewers, flags the current user and drafts", () => {
    expect(reviewSummary(pr(), ME)).toBe("1/2 approved needs-you");
    expect(reviewSummary(pr(), undefined)).toBe("1/2 approved");
    expect(reviewSummary(pr({ reviewers: [], participants: [] }), ME)).toBe("none");
    expect(reviewSummary(pr({ reviewers: [], participants: [], draft: true }), ME)).toBe("draft");
    const changes = pr({
      participants: [
        { user: ME, role: "REVIEWER", approved: false, state: "changes_requested" },
        { user: BOB, role: "REVIEWER", approved: true, state: "approved" },
      ],
    });
    expect(reviewSummary(changes, ME)).toBe("1/2 approved changes-requested");
  });

  it("counts approvals from participants who are not formal reviewers", () => {
    const drive = pr({
      reviewers: [BOB],
      participants: [
        { user: BOB, role: "REVIEWER", approved: false, state: null },
        { user: ANA, role: "PARTICIPANT", approved: true, state: "approved" },
      ],
    });
    expect(reviewers(drive).map((r) => `${r.name}:${r.status}`)).toEqual([
      "Bob Builder:pending",
      "Ana Author:approved",
    ]);
  });

  it("summarises build statuses", () => {
    expect(buildsSummary([])).toBe("none");
    expect(
      buildsSummary([
        { state: "SUCCESSFUL", name: "unit" },
        { state: "FAILED", name: "lint" },
        { state: "INPROGRESS", name: "e2e" },
      ]),
    ).toBe("1/3 passed; 1 failed (lint); 1 in progress");
  });

  it("renders comment locations in the diff's line convention", () => {
    expect(commentLocation({})).toBe("general");
    expect(commentLocation({ inline: { path: "a.ts", to: 12 } })).toBe("a.ts:12");
    expect(commentLocation({ inline: { path: "a.ts", from: 9, to: null } })).toBe("a.ts:-9");
    expect(commentLocation({ inline: { path: "a.ts" } })).toBe("a.ts");
  });
});

describe("render helpers", () => {
  it("truncates with a size hint", () => {
    expect(truncate("short", 10)).toEqual({ text: "short", truncated: false, total: 5 });
    const cut = truncate("x".repeat(50), 10);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toContain("(truncated, 50 chars total)");
    expect(truncateTail(`${"a\n".repeat(50)}END`, 10).text).toMatch(/END$/);
  });

  it("formats counts and relative times", () => {
    expect(countLine(3, 3, false)).toBe("3");
    expect(countLine(3, 40, true)).toBe("3 of 40 total");
    expect(countLine(3, undefined, true)).toBe("3+ (more available)");
    const now = Date.parse("2026-01-10T00:00:00Z");
    expect(relTime("2026-01-09T21:00:00Z", now)).toBe("3h ago");
    expect(relTime("garbage", now)).toBe("unknown");
  });
});

describe("version fast path", () => {
  it("keeps src/version.ts a leaf module (node builtins only)", () => {
    const source = readFileSync(new URL("../src/version.ts", import.meta.url), "utf-8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.every((specifier) => specifier?.startsWith("node:"))).toBe(true);
  });
});
