import { readConfig } from "./config.js";
import { axiError } from "./errors.js";

const KEYCHAIN_SERVICE = "bb-axi";

export type Credentials =
  | { kind: "basic"; email: string; token: string; source: "env" | "keychain" }
  | { kind: "bearer"; token: string; source: "env" };

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

async function keychainEntry(email: string): Promise<KeyringEntry> {
  try {
    // Loaded lazily: the native module is only needed on the keychain path, and
    // an unsupported platform should degrade to the env-var path, not crash.
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry(KEYCHAIN_SERVICE, email);
  } catch {
    throw axiError("OS keychain is not available on this system", "AUTH_REQUIRED", [
      "Set BITBUCKET_EMAIL and BITBUCKET_API_TOKEN in the environment instead",
    ]);
  }
}

/**
 * Resolution order: environment (CI, one-off overrides) then OS keychain.
 *   BITBUCKET_ACCESS_TOKEN                 -> Bearer (workspace/repo/project access token)
 *   BITBUCKET_EMAIL + BITBUCKET_API_TOKEN  -> Basic (Atlassian account API token)
 */
export async function resolveCredentials(): Promise<Credentials | undefined> {
  const bearer = process.env["BITBUCKET_ACCESS_TOKEN"];
  if (bearer) return { kind: "bearer", token: bearer, source: "env" };

  const envEmail = process.env["BITBUCKET_EMAIL"];
  const envToken = process.env["BITBUCKET_API_TOKEN"];
  if (envEmail && envToken) {
    return { kind: "basic", email: envEmail, token: envToken, source: "env" };
  }

  if (process.env["BB_AXI_NO_KEYCHAIN"] === "1") return undefined;

  const email = readConfig().email;
  if (!email) return undefined;
  try {
    const token = (await keychainEntry(email)).getPassword();
    return token ? { kind: "basic", email, token, source: "keychain" } : undefined;
  } catch {
    return undefined;
  }
}

export async function requireCredentials(): Promise<Credentials> {
  const credentials = await resolveCredentials();
  if (!credentials) {
    throw axiError("not authenticated with Bitbucket", "AUTH_REQUIRED", [
      "Run `<token-command> | bb-axi auth login --email <atlassian-email> --token-stdin`",
      "Or set BITBUCKET_EMAIL and BITBUCKET_API_TOKEN in the environment",
    ]);
  }
  return credentials;
}

export async function storeToken(email: string, token: string): Promise<void> {
  (await keychainEntry(email)).setPassword(token);
}

/** Returns true when a stored token was removed, false when there was none. */
export async function clearToken(email: string): Promise<boolean> {
  try {
    return (await keychainEntry(email)).deletePassword();
  } catch {
    return false;
  }
}

export function authorizationHeader(credentials: Credentials): string {
  if (credentials.kind === "bearer") return `Bearer ${credentials.token}`;
  const raw = `${credentials.email}:${credentials.token}`;
  return `Basic ${Buffer.from(raw, "utf-8").toString("base64")}`;
}
