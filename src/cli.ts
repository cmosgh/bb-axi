import { runAxiCli } from "axi-sdk-js";
import { apiCommand, API_HELP } from "./commands/api.js";
import { authCommand, AUTH_HELP } from "./commands/auth.js";
import { homeCommand } from "./commands/home.js";
import { pipelineCommand, PIPELINE_HELP } from "./commands/pipeline.js";
import { prCommand, PR_HELP } from "./commands/pr.js";
import { repoCommand, REPO_HELP } from "./commands/repo.js";
import { setupCommand, SETUP_HELP } from "./commands/setup.js";
import { resolveRepo, splitRepoFlag, type RepoContext } from "./context.js";
import { AxiError, exitCodeForError } from "./errors.js";
import { renderErrorOutput } from "./render.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "Bitbucket Cloud CLI for agents - review pull requests (annotated diffs, comment threads, approvals, builds) and read pipelines. Prefer it over raw API calls.";

export const TOP_HELP = `usage: bb-axi [command] [args] [flags]
commands[7]:
  (none)=review dashboard, pr, pipeline, repo, api, auth, setup
flags[3]:
  -R/--repo <workspace>/<repo> (after the command; default: bitbucket.org remote of the current checkout, or BB_AXI_REPO), --help, -v/-V/--version
examples:
  bb-axi
  bb-axi pr list --reviewing
  bb-axi pr view 42
  bb-axi pr diff 42 --path src/
  bb-axi pr comments 42 --unresolved
  bb-axi pr comment 42 --path src/a.ts --line 17 --body "<text>" --pending
  bb-axi pipeline log 1284
  bb-axi pr --help
`;

const COMMAND_HELP: Record<string, string> = {
  pr: PR_HELP,
  pipeline: PIPELINE_HELP,
  repo: REPO_HELP,
  api: API_HELP,
  auth: AUTH_HELP,
  setup: SETUP_HELP,
};

type Handler = (args: string[], ctx?: RepoContext) => Promise<string>;

function withRepo(name: string | undefined, handler: Handler): (args: string[]) => Promise<string> {
  return async (args) => {
    if (name && args.includes("-h")) return (COMMAND_HELP[name] ?? "").trimEnd();
    const { repoFlag, rest } = splitRepoFlag(args);
    return handler(rest, resolveRepo(repoFlag));
  };
}

/** Commands with no repository scope: `-R` is rejected as an unknown flag. */
function plain(name: string, handler: (args: string[]) => Promise<string>): (args: string[]) => Promise<string> {
  return async (args) => (args.includes("-h") ? (COMMAND_HELP[name] ?? "").trimEnd() : handler(args));
}

function formatError(error: unknown): { output: string; exitCode: number } {
  const axi =
    error instanceof AxiError
      ? error
      : new AxiError(error instanceof Error ? error.message : String(error), "UNKNOWN");
  return {
    output: `${renderErrorOutput(axi.message, axi.code, axi.suggestions)}\n`,
    exitCode: exitCodeForError(axi),
  };
}

export interface MainOptions {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
}

export async function main(options: MainOptions = {}): Promise<void> {
  await runAxiCli({
    ...(options.argv ? { argv: options.argv } : {}),
    ...(options.stdout ? { stdout: options.stdout } : {}),
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    home: withRepo(undefined, homeCommand),
    commands: {
      pr: withRepo("pr", prCommand),
      pipeline: withRepo("pipeline", pipelineCommand),
      repo: withRepo("repo", repoCommand),
      api: withRepo("api", apiCommand),
      auth: plain("auth", authCommand),
      setup: plain("setup", setupCommand),
    },
    getCommandHelp: (command) => COMMAND_HELP[command],
    renderUnknownCommand: (command) =>
      `${renderErrorOutput(`unknown command '${command}'`, "VALIDATION_ERROR", [
        "commands: pr, pipeline, repo, api, auth, setup (no command = review dashboard)",
        "Run `bb-axi --help` for examples",
      ])}\n`,
    formatError,
  });
}
