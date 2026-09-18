import { bbJson } from "./client.js";
import { readConfig, writeConfig, type CachedUser } from "./config.js";
import { resolveCredentials, type Credentials } from "./credentials.js";
import { obj, str } from "./render.js";

export interface Me {
  uuid: string;
  display_name: string;
}

export async function fetchUser(credentials: Credentials): Promise<Me> {
  const user = obj(await bbJson("/user", { credentials }));
  return { uuid: str(user["uuid"]), display_name: str(user["display_name"]) };
}

/**
 * The authenticated user, cached in config.json keyed by email so commands do
 * not pay a `/user` round trip on every invocation. Access tokens (Bearer) are
 * not users, so identity-based features degrade to `undefined` there.
 */
export async function currentUser(options: { timeoutMs?: number } = {}): Promise<Me | undefined> {
  const credentials = await resolveCredentials();
  if (!credentials || credentials.kind !== "basic") return undefined;

  const config = readConfig();
  if (config.user && config.user.email === credentials.email && config.user.uuid) {
    return { uuid: config.user.uuid, display_name: config.user.display_name };
  }

  try {
    const user = obj(await bbJson("/user", { timeoutMs: options.timeoutMs }));
    const cached: CachedUser = {
      uuid: str(user["uuid"]),
      display_name: str(user["display_name"]),
      email: credentials.email,
    };
    if (!cached.uuid) return undefined;
    try {
      writeConfig({ ...config, user: cached });
    } catch {
      // cache is an optimisation; a read-only config dir must not fail the command
    }
    return { uuid: cached.uuid, display_name: cached.display_name };
  } catch {
    return undefined;
  }
}
