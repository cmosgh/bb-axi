import { readConfig } from "./config.js";
import { axiError, usageError } from "./errors.js";

const KEYCHAIN_SERVICE = "bb-axi";

export type Credentials =
  | { kind: "basic"; email: string; token: string; source: "env" | "keychain"; profile?: string }
  | { kind: "bearer"; token: string; source: "env" };

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

async function keychainEntry(account: string): Promise<KeyringEntry> {
  try {
    // Loaded lazily: the native module is only needed on the keychain path, and
    // an unsupported platform should degrade to the env-var path, not crash.
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry(KEYCHAIN_SERVICE, account);
  } catch {
    throw axiError("OS keychain is not available on this system", "AUTH_REQUIRED", [
      "Set BITBUCKET_EMAIL and BITBUCKET_API_TOKEN in the environment instead",
    ]);
  }
}

let profileFlag: string | undefined;

/** `-p/--profile` of this invocation; it wins over the BITBUCKET_* environment. */
export function setProfileFlag(name: string | undefined): void {
  profileFlag = name;
}

export function profileFlagValue(): string | undefined {
  return profileFlag;
}

/** The profile a command uses: -p/--profile, then BB_AXI_PROFILE, then the active one. */
export function selectedProfile(explicit: string | undefined = profileFlag): string | undefined {
  return explicit ?? (process.env["BB_AXI_PROFILE"] || undefined) ?? readConfig().active;
}

export const LOGIN_HINT = "Run `<token-command> | bb-axi auth login --email <atlassian-email> --token-stdin [--profile <name>]`";

/**
 * Resolution order: -p/--profile, then the environment (CI, one-off overrides), then
 * BB_AXI_PROFILE or the active profile from the OS keychain.
 *   BITBUCKET_ACCESS_TOKEN                 -> Bearer (workspace/repo/project access token)
 *   BITBUCKET_EMAIL + BITBUCKET_API_TOKEN  -> Basic (Atlassian account API token)
 */
export async function resolveCredentials(): Promise<Credentials | undefined> {
  if (!profileFlag) {
    const bearer = process.env["BITBUCKET_ACCESS_TOKEN"];
    if (bearer) return { kind: "bearer", token: bearer, source: "env" };
    const envEmail = process.env["BITBUCKET_EMAIL"];
    const envToken = process.env["BITBUCKET_API_TOKEN"];
    if (envEmail && envToken) return { kind: "basic", email: envEmail, token: envToken, source: "env" };
  }

  const name = selectedProfile();
  const profiles = readConfig().profiles ?? {};
  if (profileFlag && profiles[profileFlag] === undefined) {
    throw usageError(`no profile '${profileFlag}'`, [`profiles: ${Object.keys(profiles).join(", ") || "none"}`, LOGIN_HINT]);
  }
  if (process.env["BB_AXI_NO_KEYCHAIN"] === "1") return undefined;
  const profile = name ? profiles[name] : undefined;
  if (!name || !profile || typeof profile.email !== "string") return undefined;
  try {
    const token = await readToken(name, profile.email);
    return token ? { kind: "basic", email: profile.email, token, source: "keychain", profile: name } : undefined;
  } catch {
    return undefined;
  }
}

/** Under the profile name; a login from before profiles kept it under the email. */
async function readToken(profile: string, email: string): Promise<string | null> {
  return (await keychainEntry(profile)).getPassword() ?? (await keychainEntry(email)).getPassword();
}

export async function requireCredentials(): Promise<Credentials> {
  const credentials = await resolveCredentials();
  if (!credentials) {
    throw axiError("not authenticated with Bitbucket", "AUTH_REQUIRED", [
      LOGIN_HINT,
      "Or set BITBUCKET_EMAIL and BITBUCKET_API_TOKEN in the environment",
    ]);
  }
  return credentials;
}

export async function storeToken(profile: string, token: string): Promise<void> {
  (await keychainEntry(profile)).setPassword(token);
}

/** Removes the profile's token and any pre-profile entry under its email; true when one was removed. */
export async function clearToken(profile: string, email?: string): Promise<boolean> {
  let removed = false;
  for (const account of email ? [profile, email] : [profile]) {
    try {
      removed = (await keychainEntry(account)).deletePassword() || removed;
    } catch {
      // nothing stored, or no keychain
    }
  }
  return removed;
}

export function authorizationHeader(credentials: Credentials): string {
  if (credentials.kind === "bearer") return `Bearer ${credentials.token}`;
  const raw = `${credentials.email}:${credentials.token}`;
  return `Basic ${Buffer.from(raw, "utf-8").toString("base64")}`;
}
