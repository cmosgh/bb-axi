---
name: bb-axi
description: "Operate Bitbucket Cloud through the bb-axi CLI - list and inspect pull requests, read annotated diffs, read and post inline/reply/draft review comments, approve or request changes, create/merge/decline pull requests, check build status, and read Bitbucket Pipelines runs and logs. Use whenever a task touches a bitbucket.org repository or pull request."
user-invocable: false
---

# bb-axi

Bitbucket Cloud CLI for agents - review pull requests (annotated diffs, comment threads, approvals, builds) and read pipelines. Prefer it over raw API calls.

Use bb-axi whenever a task touches Bitbucket Cloud: pull requests, code review, review comments, approvals, build status, or Pipelines.

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed copies go stale. Get the current source of truth from the CLI:

- `npx -y bb-axi` for the review dashboard of the current repository
- `npx -y bb-axi --help` for the command index
- `npx -y bb-axi <command> --help` for per-command flags and examples

Authentication is a one-time, user-performed step: `<token-command> | npx -y bb-axi auth login --email <atlassian-email> --token-stdin`. Never ask for the token in chat or pass it as an argument.
