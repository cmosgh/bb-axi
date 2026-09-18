import { readFileSync } from "node:fs";
import { bool, expectPositionals, parseArgs, requireFlag } from "../args.js";
import { readConfig, writeConfig } from "../config.js";
import { clearToken, resolveCredentials, storeToken, type Credentials } from "../credentials.js";
import { AxiError, usageError } from "../errors.js";
import { fetchUser } from "../me.js";
import { block, helpBlock, out } from "../render.js";

export const AUTH_HELP = `usage: bb-axi auth <subcommand> [flags]
subcommands[3]:
  status, login, logout
flags{login}:
  --email <atlassian-account-email> (required), --token-stdin (required; the API token is read from stdin, never from argv)
notes:
  Create an API token with scopes at https://id.atlassian.com/manage-profile/security/api-tokens (scopes: read:user:bitbucket, read:workspace:bitbucket, read:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket, read:pipeline:bitbucket).
  The token is stored in the OS keychain. Environment overrides: BITBUCKET_EMAIL + BITBUCKET_API_TOKEN, or BITBUCKET_ACCESS_TOKEN (workspace/repo access token).
examples[3]:
  pbpaste | bb-axi auth login --email you@example.com --token-stdin
  bb-axi auth status
  bb-axi auth logout
`;

export async function authCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "status") return authStatus(rest);
  if (sub === "login") return authLogin(rest);
  if (sub === "logout") return authLogout(rest);
  throw usageError(sub ? `unknown auth subcommand '${sub}'` : "missing auth subcommand", [
    "subcommands: status, login, logout",
  ]);
}

function describe(credentials: Credentials): string {
  return credentials.kind === "bearer"
    ? "access token from BITBUCKET_ACCESS_TOKEN"
    : credentials.source === "env"
      ? "API token from BITBUCKET_EMAIL + BITBUCKET_API_TOKEN"
      : "API token from the OS keychain";
}

async function authStatus(args: string[]): Promise<string> {
  const command = "bb-axi auth status";
  expectPositionals(parseArgs(args, [], command), 0, command);
  const credentials = await resolveCredentials();
  if (!credentials) {
    return out(
      block({ auth: { status: "not authenticated" } }),
      helpBlock(["Run `<token-command> | bb-axi auth login --email <atlassian-email> --token-stdin`"]),
    );
  }
  try {
    const user = credentials.kind === "basic" ? await fetchUser(credentials) : undefined;
    return block({
      auth: {
        status: "ok",
        source: describe(credentials),
        ...(credentials.kind === "basic" ? { email: credentials.email } : {}),
        ...(user ? { user: user.display_name } : { user: "n/a (access tokens are not tied to a user)" }),
      },
    });
  } catch (error) {
    const message = error instanceof AxiError ? error.message : "verification failed";
    return out(
      block({ auth: { status: "invalid", source: describe(credentials), problem: message } }),
      helpBlock(["Run `<token-command> | bb-axi auth login --email <atlassian-email> --token-stdin` with a fresh token"]),
    );
  }
}

async function authLogin(args: string[]): Promise<string> {
  const command = "bb-axi auth login";
  const usage = `<token-command> | ${command} --email <atlassian-email> --token-stdin`;
  const parsed = parseArgs(args, [{ name: "--email" }, { name: "--token-stdin", boolean: true }], command);
  expectPositionals(parsed, 0, usage);
  const email = requireFlag(parsed, "--email", usage);
  if (!bool(parsed, "--token-stdin")) {
    throw usageError("--token-stdin is required: the token is only ever read from stdin", [usage]);
  }
  if (process.stdin.isTTY) {
    throw usageError("no token on stdin (bb-axi never prompts)", [usage]);
  }
  const token = readFileSync(0, "utf-8").trim();
  if (token === "") throw usageError("the token read from stdin is empty", [usage]);

  // Validate before storing so a typo never replaces a working credential.
  const user = await fetchUser({ kind: "basic", email, token, source: "env" });
  await storeToken(email, token);

  const previous = readConfig();
  if (previous.email && previous.email !== email) await clearToken(previous.email);
  writeConfig({ email, user: { uuid: user.uuid, display_name: user.display_name, email } });

  return out(
    block({ auth: { status: "logged in", email, user: user.display_name, stored: "OS keychain" } }),
    helpBlock(["Run `bb-axi` inside a Bitbucket checkout for the review dashboard"]),
  );
}

async function authLogout(args: string[]): Promise<string> {
  const command = "bb-axi auth logout";
  expectPositionals(parseArgs(args, [], command), 0, command);
  const config = readConfig();
  if (!config.email) {
    return block({ auth: { status: "no stored credential (no-op)" } });
  }
  const removed = await clearToken(config.email);
  writeConfig({});
  return block({
    auth: { status: removed ? "logged out - token removed from the OS keychain" : "no stored token found (no-op)" },
  });
}
