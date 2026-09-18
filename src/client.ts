import {
  authorizationHeader,
  requireCredentials,
  type Credentials,
} from "./credentials.js";
import { axiError, AxiError } from "./errors.js";
import { arr, dig, num, obj, str } from "./render.js";
import { VERSION } from "./version.js";

const DEFAULT_API_BASE = "https://api.bitbucket.org/2.0";
const DEFAULT_TIMEOUT_MS = 30_000;

/** Array values become repeated parameters (`state=OPEN&state=MERGED`). */
export type Query = Record<string, string | number | readonly string[] | undefined>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Query;
  body?: unknown;
  timeoutMs?: number;
  /** Supply credentials explicitly (used by `auth login` before storing). */
  credentials?: Credentials;
}

export function apiBase(): string {
  const override = process.env["BB_AXI_API_BASE"];
  if (!override) return DEFAULT_API_BASE;
  const url = new URL(override);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  // The Authorization header goes wherever this points - never over plain
  // HTTP to a remote host.
  if (url.protocol !== "https:" && !local) {
    throw axiError("BB_AXI_API_BASE must use https", "VALIDATION_ERROR");
  }
  return override.replace(/\/+$/, "");
}

function buildUrl(pathOrUrl: string, query?: Query): URL {
  const base = apiBase();
  const url = /^https?:\/\//.test(pathOrUrl)
    ? new URL(pathOrUrl)
    : new URL(`${base}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`);
  // Pagination `next` links come from the server; only ever send credentials
  // to the configured API origin.
  if (url.origin !== new URL(base).origin) {
    throw axiError(`refusing to send credentials to ${url.origin}`, "API_ERROR");
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (typeof value === "string" || typeof value === "number") {
      url.searchParams.set(key, String(value));
    } else {
      for (const item of value) url.searchParams.append(key, item);
    }
  }
  return url;
}

function apiMessage(bodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const message = str(dig(parsed, "error", "message"));
    const detail = dig(parsed, "error", "detail");
    const extra = typeof detail === "string" ? detail : "";
    return [message, extra].filter(Boolean).join(" - ").slice(0, 300);
  } catch {
    return "";
  }
}

function errorForStatus(status: number, bodyText: string, method: string): AxiError {
  const message = apiMessage(bodyText);
  const suffix = message ? `: ${message}` : "";
  switch (status) {
    case 401:
      return axiError(`Bitbucket rejected the credentials${suffix}`, "AUTH_REQUIRED", [
        "Run `bb-axi auth status` to check the configured account",
        "Run `<token-command> | bb-axi auth login --email <atlassian-email> --token-stdin` to replace the token",
      ]);
    case 403:
      return axiError(`access denied${suffix}`, "FORBIDDEN", [
        method === "GET"
          ? "The API token is likely missing a read scope (read:repository:bitbucket, read:pullrequest:bitbucket, read:pipeline:bitbucket)"
          : "The API token is likely missing a write scope (write:pullrequest:bitbucket) or you lack permission on this repository",
      ]);
    case 404:
      return axiError(`not found${suffix}`, "NOT_FOUND", [
        "Check the id and the repository (`-R <workspace>/<repo>`); private repositories also return 404 when the token lacks access",
      ]);
    case 409:
      return axiError(`conflict${suffix}`, "CONFLICT");
    case 429:
      return axiError("Bitbucket API rate limit reached", "RATE_LIMITED", [
        "Wait a few minutes before retrying",
      ]);
    default:
      return axiError(`Bitbucket API error ${status}${suffix}`, "API_ERROR");
  }
}

async function send(pathOrUrl: string, options: RequestOptions, accept: string): Promise<Response> {
  const method = options.method ?? "GET";
  const url = buildUrl(pathOrUrl, options.query);
  const credentials = options.credentials ?? (await requireCredentials());
  const headers: Record<string, string> = {
    Accept: accept,
    Authorization: authorizationHeader(credentials),
    "User-Agent": `bb-axi/${VERSION}`,
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw axiError(
      timedOut ? "Bitbucket API request timed out" : "could not reach the Bitbucket API",
      "NETWORK",
      ["Check the network connection and retry"],
    );
  }
  if (!response.ok) {
    throw errorForStatus(response.status, await response.text().catch(() => ""), method);
  }
  return response;
}

export async function bbJson(pathOrUrl: string, options: RequestOptions = {}): Promise<unknown> {
  const response = await send(pathOrUrl, options, "application/json");
  if (response.status === 204) return {};
  const text = await response.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw axiError("Bitbucket API returned a non-JSON response", "API_ERROR");
  }
}

export async function bbText(pathOrUrl: string, options: RequestOptions = {}): Promise<string> {
  return (await send(pathOrUrl, options, "text/plain, */*")).text();
}

export interface Page {
  values: unknown[];
  /** Total across all pages when the API reports it. */
  size: number | undefined;
  /** True when more results exist beyond `limit`. */
  more: boolean;
}

/** Follow `next` links until `limit` values are collected. */
export async function bbPaginate(
  path: string,
  options: { query?: Query; limit: number; pagelen: number; timeoutMs?: number },
): Promise<Page> {
  const values: unknown[] = [];
  let size: number | undefined;
  let next: string | undefined = path;
  let query: Query | undefined = {
    ...options.query,
    pagelen: Math.min(options.pagelen, options.limit),
  };

  while (next !== undefined && values.length < options.limit) {
    const page = obj(await bbJson(next, { query, timeoutMs: options.timeoutMs }));
    values.push(...arr(page["values"]));
    size ??= num(page["size"]);
    const link = str(page["next"]);
    next = link === "" ? undefined : link;
    query = undefined; // `next` already carries the query string
  }

  const more = next !== undefined || values.length > options.limit;
  return { values: values.slice(0, options.limit), size, more };
}
