import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { main } from "../src/cli.js";

export interface Route {
  method?: string;
  /** Path below /2.0, matched exactly unless a RegExp is given. */
  path: string | RegExp;
  status?: number;
  json?: unknown;
  text?: string;
  /** Dynamic response; wins over json/text. */
  reply?: (call: Call) => { status?: number; json?: unknown; text?: string };
}

export interface Call {
  method: string;
  url: URL;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export const ME = { uuid: "{11111111-1111-1111-1111-111111111111}", display_name: "Robin Reviewer" };
export const ANA = { uuid: "{22222222-2222-2222-2222-222222222222}", display_name: "Ana Author" };
export const BOB = { uuid: "{33333333-3333-3333-3333-333333333333}", display_name: "Bob Builder" };

/** Env-based credentials so tests never touch the real OS keychain. */
export function useTestEnv(): void {
  process.env["BITBUCKET_EMAIL"] = "robin@example.test";
  process.env["BITBUCKET_API_TOKEN"] = "test-token";
  process.env["BB_AXI_NO_KEYCHAIN"] = "1";
  process.env["BB_AXI_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "bb-axi-test-"));
  delete process.env["BITBUCKET_ACCESS_TOKEN"];
  delete process.env["BB_AXI_REPO"];
  delete process.env["BB_AXI_API_BASE"];
}

export function mockApi(routes: Route[]): { calls: Call[] } {
  const calls: Call[] = [];
  const all: Route[] = [...routes, { path: "/user", json: ME }];
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/2\.0/, "");
    const call: Call = {
      method,
      url,
      path,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const route = all.find(
      (r) =>
        (r.method ?? "GET") === method &&
        (typeof r.path === "string" ? r.path === path : r.path.test(path)),
    );
    if (!route) {
      return new Response(JSON.stringify({ error: { message: `no mock for ${method} ${path}` } }), { status: 404 });
    }
    const dynamic = route.reply?.(call);
    const status = dynamic?.status ?? route.status ?? 200;
    const text = dynamic?.text ?? route.text;
    const json = dynamic?.json ?? route.json;
    // A 204 must not carry a body; Response throws if given one.
    return new Response(status === 204 ? null : (text ?? JSON.stringify(json ?? {})), { status });
  });
  return { calls };
}

export async function run(...argv: string[]): Promise<{ stdout: string; exitCode: number }> {
  let stdout = "";
  process.exitCode = 0;
  await main({ argv, stdout: { write: (chunk: string) => (stdout += chunk) } });
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { stdout, exitCode };
}

export const REPO = ["-R", "acme/widgets"] as const;
export const BASE = "/repositories/acme/widgets";

export function pr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    title: "Add retry to the sync worker",
    state: "OPEN",
    draft: false,
    author: ANA,
    source: { branch: { name: "feature/retry" }, commit: { hash: "aaaaaaaaaaaa" } },
    destination: { branch: { name: "develop" }, commit: { hash: "bbbbbbbbbbbb" } },
    reviewers: [ME, BOB],
    participants: [
      { user: ME, role: "REVIEWER", approved: false, state: null },
      { user: BOB, role: "REVIEWER", approved: true, state: "approved" },
    ],
    comment_count: 3,
    task_count: 1,
    created_on: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    updated_on: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    description: "Retries transient failures with backoff.",
    links: { html: { href: "https://bitbucket.org/acme/widgets/pull-requests/42" } },
    ...overrides,
  };
}
