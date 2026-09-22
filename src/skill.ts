import { DESCRIPTION } from "./cli.js";

// Trigger string agents match against to auto-load the skill. Terse and
// outcome-focused so it fires on "needs Bitbucket" intents.
export const SKILL_DESCRIPTION =
  "Operate Bitbucket Cloud through the bb-axi CLI - list and inspect pull requests, read annotated diffs, read and post " +
  "inline/reply/draft review comments, resolve threads, approve or request changes, create/merge/decline pull requests, check build status, " +
  "and read Bitbucket Pipelines runs and logs. Use whenever a task touches a bitbucket.org repository or pull request.";

// Hard cap so a regeneration cannot re-inflate the stub with CLI-owned
// guidance. The dashboard and --help output are the source of truth.
export const MAX_SKILL_MARKDOWN_CHARS = 2000;

/**
 * Render the installable SKILL.md. A discovery stub, not a copy of the CLI's
 * guidance: installed skills go stale, `bb-axi --help` does not.
 */
export function createSkillMarkdown(): string {
  const markdown = `---
name: bb-axi
description: ${JSON.stringify(SKILL_DESCRIPTION)}
user-invocable: false
---

# bb-axi

${DESCRIPTION}

Use bb-axi whenever a task touches Bitbucket Cloud: pull requests, code review, review comments, approvals, build status, or Pipelines.

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed copies go stale. Get the current source of truth from the CLI:

- \`npx -y bb-axi\` for the review dashboard of the current repository
- \`npx -y bb-axi --help\` for the command index
- \`npx -y bb-axi <command> --help\` for per-command flags and examples

Authentication is a one-time, user-performed step: \`<token-command> | npx -y bb-axi auth login --email <atlassian-email> --token-stdin\`. Never ask for the token in chat or pass it as an argument.
`;

  if (markdown.length > MAX_SKILL_MARKDOWN_CHARS) {
    throw new Error(
      `generated SKILL.md is ${markdown.length} chars; keep it under ${MAX_SKILL_MARKDOWN_CHARS} and defer guidance to the CLI`,
    );
  }
  return markdown;
}
