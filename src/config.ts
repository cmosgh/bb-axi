import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CachedUser {
  uuid: string;
  display_name: string;
  /** Email the identity was resolved with; a different email invalidates it. */
  email: string;
}

/** One Atlassian account. The token lives in the OS keychain under the profile name, never here. */
export interface Profile {
  email: string;
  user?: CachedUser;
}

/** Non-secret settings only. */
export interface Config {
  active?: string;
  profiles?: Record<string, Profile>;
  /** Identity of the BITBUCKET_EMAIL environment credentials. */
  user?: CachedUser;
}

/** Name a pre-profile login is read as; its token stays under the email in the keychain. */
export const LEGACY_PROFILE = "default";

export function configDir(): string {
  const override = process.env["BB_AXI_CONFIG_DIR"];
  if (override) return override;
  const xdg = process.env["XDG_CONFIG_HOME"];
  return join(xdg && xdg !== "" ? xdg : join(homedir(), ".config"), "bb-axi");
}

function configPath(): string {
  return join(configDir(), "config.json");
}

export function readConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const raw = parsed as Config & { email?: unknown; user?: CachedUser };
    // 0.1.x stored one account at the top level.
    if (typeof raw.email === "string" && raw.profiles === undefined) {
      return { active: LEGACY_PROFILE, profiles: { [LEGACY_PROFILE]: { email: raw.email, ...(raw.user ? { user: raw.user } : {}) } } };
    }
    return {
      ...(typeof raw.active === "string" ? { active: raw.active } : {}),
      ...(raw.profiles && typeof raw.profiles === "object" ? { profiles: raw.profiles } : {}),
      ...(raw.user ? { user: raw.user } : {}),
    };
  } catch {
    // A corrupt config must not brick the CLI; treat it as empty.
    return {};
  }
}

export function writeConfig(config: Config): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function validProfileName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name);
}
