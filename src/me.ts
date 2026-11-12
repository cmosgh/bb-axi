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

  // Cached per profile; environment credentials use the top-level slot.
  const config = readConfig();
  const name = credentials.profile;
  const profile = name ? config.profiles?.[name] : undefined;
  const known = name ? profile?.user : config.user;
  if (known && known.email === credentials.email && known.uuid) {
    return { uuid: known.uuid, display_name: known.display_name };
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
      writeConfig(name && profile ? { ...config, profiles: { ...config.profiles, [name]: { ...profile, user: cached } } } : { ...config, user: cached });
    } catch {
      // cache is an optimisation; a read-only config dir must not fail the command
    }
    return { uuid: cached.uuid, display_name: cached.display_name };
  } catch {
    return undefined;
  }
}
