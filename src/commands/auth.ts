import { readFileSync } from "node:fs";
import { bool, expectPositionals, flag, parseArgs, requireFlag } from "../args.js";
import { LEGACY_PROFILE, readConfig, validProfileName, writeConfig } from "../config.js";
import { clearToken, LOGIN_HINT, resolveCredentials, selectedProfile, setProfileFlag, storeToken, type Credentials } from "../credentials.js";
import { AxiError, usageError } from "../errors.js";
import { fetchUser } from "../me.js";
import { block, helpBlock, out } from "../render.js";

export const AUTH_HELP = `usage: bb-axi auth <subcommand> [flags]
subcommands[4]:
  status, login, use <profile>, logout
flags{login}:
  --email <atlassian-account-email> (required), --token-stdin (required; the API token is read from stdin, never from argv), --profile <name> (default: the active profile, or 'default')
flags{logout}:
  --profile <name> (default: the active profile)
notes:
  Create an API token with scopes at https://id.atlassian.com/manage-profile/security/api-tokens (scopes: read:user:bitbucket, read:workspace:bitbucket, read:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket, read:pipeline:bitbucket; add write:pipeline:bitbucket for pipeline rerun/stop).
  Tokens are stored in the OS keychain, one per profile; profiles (email only) live in ~/.config/bb-axi. Login makes the profile active.
  Pick a profile with -p/--profile <name> on any command, or BB_AXI_PROFILE for a single command. Environment overrides: BITBUCKET_EMAIL + BITBUCKET_API_TOKEN, or BITBUCKET_ACCESS_TOKEN (workspace/repo access token); they win over the profiles unless -p is given.
examples[5]:
  pbpaste | bb-axi auth login --email you@example.com --token-stdin
  pbpaste | bb-axi auth login --profile client --email you@client.example --token-stdin
  bb-axi auth use client
  bb-axi pr list -p client
  bb-axi auth logout --profile client
`;

export async function authCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "status") return authStatus(rest);
  if (sub === "login") return authLogin(rest);
  if (sub === "use") return authUse(rest);
  if (sub === "logout") return authLogout(rest);
  throw usageError(sub ? `unknown auth subcommand '${sub}'` : "missing auth subcommand", [
    "subcommands: status, login, use, logout",
  ]);
}

function describe(credentials: Credentials): string {
  return credentials.kind === "bearer"
    ? "access token from BITBUCKET_ACCESS_TOKEN"
    : credentials.source === "env"
      ? "API token from BITBUCKET_EMAIL + BITBUCKET_API_TOKEN"
      : `API token from the OS keychain (profile ${credentials.profile})`;
}

function profileRows(): Array<{ name: string; email: string; active: boolean }> {
  const active = selectedProfile();
  return Object.entries(readConfig().profiles ?? {}).map(([name, p]) => ({
    name,
    email: typeof p?.email === "string" ? p.email : "invalid - no email",
    active: name === active,
  }));
}

async function authStatus(args: string[]): Promise<string> {
  const command = "bb-axi auth status";
  const parsed = parseArgs(args, [{ name: "--profile", alias: "-p" }], command);
  expectPositionals(parsed, 0, `${command} [-p <profile>]`);
  setProfileFlag(flag(parsed, "--profile"));
  const profiles = profileRows();
  const listing = profiles.length > 1 ? block({ profiles }) : "";
  const credentials = await resolveCredentials();
  if (!credentials) {
    return out(block({ auth: { status: "not authenticated" } }), listing, helpBlock([LOGIN_HINT]));
  }
  try {
    const user = credentials.kind === "basic" ? await fetchUser(credentials) : undefined;
    return out(
      block({
        auth: {
          status: "ok",
          source: describe(credentials),
          ...(credentials.kind === "basic" ? { email: credentials.email } : {}),
          ...(user ? { user: user.display_name } : { user: "n/a (access tokens are not tied to a user)" }),
        },
      }),
      listing,
    );
  } catch (error) {
    const message = error instanceof AxiError ? error.message : "verification failed";
    return out(
      block({ auth: { status: "invalid", source: describe(credentials), problem: message } }),
      listing,
      helpBlock([`${LOGIN_HINT} with a fresh token`]),
    );
  }
}

async function authLogin(args: string[]): Promise<string> {
  const command = "bb-axi auth login";
  const usage = `<token-command> | ${command} --email <atlassian-email> --token-stdin [--profile <name>]`;
  const parsed = parseArgs(
    args,
    [{ name: "--email" }, { name: "--token-stdin", boolean: true }, { name: "--profile", alias: "-p" }],
    command,
  );
  expectPositionals(parsed, 0, usage);
  const email = requireFlag(parsed, "--email", usage);
  const config = readConfig();
  const name = flag(parsed, "--profile") ?? config.active ?? LEGACY_PROFILE;
  if (!validProfileName(name)) throw usageError(`invalid profile name '${name}' - use letters, digits, '.', '_' and '-'`);
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
  const previous = config.profiles?.[name];
  // A pre-profile token sits under the old email; the profile name holds it from now on.
  await storeToken(name, token);
  if (previous?.email) await clearToken(previous.email);
  writeConfig({
    ...config,
    active: name,
    profiles: { ...config.profiles, [name]: { email, user: { uuid: user.uuid, display_name: user.display_name, email } } },
  });

  return out(
    block({ auth: { status: "logged in", profile: name, email, user: user.display_name, stored: "OS keychain", active: true } }),
    helpBlock(["Run `bb-axi` inside a Bitbucket checkout for the review dashboard"]),
  );
}

async function authUse(args: string[]): Promise<string> {
  const command = "bb-axi auth use";
  const [name] = expectPositionals(parseArgs(args, [], command), 1, `${command} <profile>`);
  const config = readConfig();
  const profiles = Object.keys(config.profiles ?? {});
  if (!profiles.includes(name!)) throw usageError(`no profile '${name}'`, [`profiles: ${profiles.join(", ") || "none"}`, LOGIN_HINT]);
  if (config.active === name) return block({ auth: { active: name, result: "already active (no-op)" } });
  writeConfig({ ...config, active: name! });
  const envWins = Boolean(process.env["BITBUCKET_ACCESS_TOKEN"] || (process.env["BITBUCKET_EMAIL"] && process.env["BITBUCKET_API_TOKEN"]));
  return out(
    block({ auth: { active: name, result: "switched" } }),
    helpBlock(envWins ? ["BITBUCKET_* credentials are set in the environment and still win unless -p is given"] : []),
  );
}

async function authLogout(args: string[]): Promise<string> {
  const command = "bb-axi auth logout";
  const parsed = parseArgs(args, [{ name: "--profile", alias: "-p" }], command);
  expectPositionals(parsed, 0, `${command} [--profile <name>]`);
  const config = readConfig();
  const name = flag(parsed, "--profile") ?? config.active;
  const profiles = { ...config.profiles };
  if (!name || profiles[name] === undefined) return block({ auth: { status: "no such profile (no-op)" } });
  const removed = await clearToken(name, profiles[name]?.email);
  delete profiles[name];
  const active = config.active === name ? Object.keys(profiles)[0] : config.active;
  const { user } = config;
  writeConfig({ ...(active ? { active } : {}), profiles, ...(user ? { user } : {}) });
  return block({
    auth: {
      profile: name,
      status: removed ? "logged out - token removed from the OS keychain" : "removed - no stored token found",
      active: active ?? "none",
    },
  });
}
