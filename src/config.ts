import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CachedUser {
  uuid: string;
  display_name: string;
  /** Email the identity was resolved with; a different email invalidates it. */
  email: string;
}

/** Non-secret settings only. Tokens live in the OS keychain, never here. */
export interface Config {
  email?: string;
  user?: CachedUser;
}

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
    return parsed !== null && typeof parsed === "object" ? (parsed as Config) : {};
  } catch {
    // A corrupt config must not brick the CLI; treat it as empty.
    return {};
  }
}

export function writeConfig(config: Config): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
