# bb-axi

Agent-ergonomic **Bitbucket Cloud** CLI, built on the [AXI](https://axi.md) principles: token-efficient [TOON](https://toonformat.dev/) output, minimal schemas, pre-computed aggregates, definitive empty states, structured errors, idempotent mutations, and next-step hints.

It is **pull-request-review first**. The thing agents get wrong when reviewing on Bitbucket is the plumbing - which line number an inline comment targets, which threads are still open, whether the build is green - so `bb-axi` computes that for them.

```
$ bb-axi pr diff 42
pr: 42
files_changed: 1
lines: +6 -1
files[1]{path,status,added,removed}:
  src/sync/worker.ts,modified,6,1
diff: annotated - leading number is the NEW file line, except on "-" lines where it is the OLD file line
---
== src/sync/worker.ts
@@ -14,7 +14,12 @@ export async function runSync(job: Job) {
  14    const client = createClient(job.tenant);
  15 -  const result = await client.push(job.payload);
  15 +  let attempt = 0;
  16 +  let result;
  17 +  while (attempt < 5) {
---
help[1]:
  Inline comment: `bb-axi pr comment 42 --path <path> --line <n> --body "<text>"` (use --old-line <n> for a "-" line)
```

The number in front of every diff line is exactly what `--line` / `--old-line` expects, so an agent never does hunk-header arithmetic.

> **Status: early (v0.1.x).** Covered by unit and mocked end-to-end tests, and used against the live Bitbucket API in real review-triage loops.

## Install

Requires Node.js 20+.

```sh
npm install -g bb-axi
```

Then tell your agent about it - one line in `CLAUDE.md` / `AGENTS.md`:

```
Use `bb-axi` for anything on Bitbucket (pull requests, review comments, pipelines).
```

Or install one of the two integrations (you only need one):

```sh
bb-axi setup hooks                      # SessionStart hook: review dashboard as ambient context (Claude Code, Codex, OpenCode)
npx skills add cmosgh/bb-axi --skill bb-axi   # on-demand Agent Skill, no per-session cost
```

`setup hooks --project` scopes the hook to the current repository. Outside a Bitbucket checkout the dashboard is two lines and makes no network or keychain access.

## Authenticate

Create an [Atlassian API token with scopes](https://id.atlassian.com/manage-profile/security/api-tokens) for Bitbucket:

`read:user:bitbucket` `read:workspace:bitbucket` `read:repository:bitbucket` `read:pullrequest:bitbucket` `write:pullrequest:bitbucket` `read:pipeline:bitbucket`

```sh
pbpaste | bb-axi auth login --email you@example.com --token-stdin
bb-axi auth status
```

- The token is read **only from stdin** - never from argv, so it cannot land in shell history or an agent transcript - validated against the API, then stored in the OS keychain (macOS Keychain, Windows Credential Manager, libsecret). `bb-axi` never prompts.
- Use the **Atlassian account email**, not your Bitbucket username.
- Environment overrides for CI: `BITBUCKET_EMAIL` + `BITBUCKET_API_TOKEN`, or `BITBUCKET_ACCESS_TOKEN` (workspace / repository / project access token, sent as Bearer). Access tokens are not users, so `--mine`, `--reviewing` and the comment duplicate-guard are unavailable with them.

## Commands

The repository comes from the `bitbucket.org` remote of the current checkout; override with `-R <workspace>/<repo>` after the command, or `BB_AXI_REPO`.

| Command | What it does |
| --- | --- |
| `bb-axi` | Review dashboard: open PR count, PRs awaiting **your** review, your own PRs - from one API call |
| `pr list` | `--state`, `--mine`, `--reviewing`, `--source`, `--dest`, `--query <BBQL>`, `--fields`; rows carry a review summary (`1/2 approved needs-you`) |
| `pr view <id>` | Reviewers with status, build summary (`2/3 passed; 1 failed (lint)`), comment/task counts, truncated description |
| `pr diff <id>` | File table + line-number-annotated diff. `--path <file\|dir\|glob>`, `--stat`, `--raw`, `--full`. Lockfiles and bundles are elided; 32k-char budget cut at file boundaries |
| `pr comments <id>` | Threads in order, replies under their root, `open / resolved / pending / outdated`, thread counts. `--unresolved`, `--path` |
| `pr comment <id>` | `--body` or `--body-file <path\|->`; inline with `--path` + `--line` / `--old-line`; `--reply-to <id>`; `--pending` for a draft only you can see |
| `pr resolve / unresolve <id> <comment-id>` | Resolve or reopen a thread; any comment in it works. Idempotent |
| `pr approve / unapprove / request-changes / unrequest-changes <id>` | Idempotent - repeating is a no-op, exit 0 |
| `pr create` | `--title`, `--source` (default: current branch), `--dest`, `--reviewer`, `--default-reviewers`, `--draft`. No-op if the branch already has an open PR |
| `pr merge <id>` / `pr decline <id>` | Print a preview unless `--confirm` is passed |
| `pipeline list / view <build> / log <build>` | By build number. `log` tails the first failed step |
| `repo view` / `repo list` | Repository details; repositories in a workspace |
| `api [METHOD] <path>` | Any REST 2.0 endpoint; `{workspace}`/`{repo}` are filled in; `DELETE` needs `--confirm` |
| `auth status / login / logout`, `setup hooks / status / uninstall`, `update` | Housekeeping |

`bb-axi <command> --help` prints a concise, complete flag reference.

### A review, end to end

```sh
bb-axi                                  # what needs me?
bb-axi pr view 42                       # reviewers, builds, description
bb-axi pr diff 42                       # annotated diff
bb-axi pr comments 42 --unresolved      # what is still being discussed
bb-axi pr comment 42 --path src/sync/worker.ts --line 17 \
  --body "Break out of the loop once push succeeds." --pending
bb-axi pr resolve 42 118                # close a thread once it is addressed
bb-axi pr request-changes 42
```

### Triaging feedback on your own PR

```sh
bb-axi pr comments 42 --unresolved      # open threads, with ids
# ...fix the code, push...
bb-axi pr comment 42 --reply-to 118 --body "Fixed in the latest push."
bb-axi pr resolve 42 118                # any comment id in the thread works
bb-axi pr comments 42 --unresolved      # repeat until it reports 0
```

Every step is safe to re-run: a repeated reply is a no-op and resolving a resolved thread reports `(no-op)`, so an agent can loop until nothing is left open.

`--pending` saves the comment as a Bitbucket draft: visible only to you until you publish it from the PR page. It is the safe mode for agent-drafted feedback - the human reads, edits and publishes. If Bitbucket ever publishes a comment that was requested as pending, `bb-axi` says so loudly in the result.

## Safety model

- **Destructive or irreversible actions are gated**: `pr merge`, `pr decline` and `api DELETE` only preview without `--confirm`.
- **Mutations are idempotent**: approving twice, creating a PR for a branch that has one, or re-posting an identical comment at the same location are reported as no-ops (`--allow-duplicate` overrides the comment guard). An agent that retries after a timeout cannot double-post.
- **Credentials only go to the API origin**: pagination `next` links pointing anywhere else are refused; `BB_AXI_API_BASE` must be https (or localhost).
- **No telemetry.** The only network traffic is to the Bitbucket API (and the npm registry when you run `bb-axi update`).

## Environment

| Variable | Purpose |
| --- | --- |
| `BITBUCKET_EMAIL`, `BITBUCKET_API_TOKEN` | Basic-auth credentials (override the keychain) |
| `BITBUCKET_ACCESS_TOKEN` | Bearer access token (overrides everything) |
| `BB_AXI_REPO` | Default `<workspace>/<repo>` |
| `BB_AXI_CONFIG_DIR` | Config directory (default `$XDG_CONFIG_HOME/bb-axi` or `~/.config/bb-axi`); holds the email and cached user id, never the token |
| `BB_AXI_NO_KEYCHAIN=1` | Never touch the OS keychain |
| `BB_AXI_API_BASE` | API base URL (tests / proxies) |

## Development

```sh
pnpm install
pnpm run check        # typecheck, tests, build, skill freshness
pnpm run dev -- pr list -R <workspace>/<repo>
```

Tests mock HTTP and use environment credentials; they need no Bitbucket account and never touch the real keychain. `skills/bb-axi/SKILL.md` is generated from `src/skill.ts` - run `pnpm run build:skill` after changing it.

## Scope

Bitbucket **Cloud** only (REST API 2.0). Bitbucket Data Center / Server has a different API and is not supported.

Not affiliated with or endorsed by Atlassian. Bitbucket is a trademark of Atlassian.

## License

MIT
