import { readFileSync as realRead, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASE, mockApi, REPO, run, useTestEnv, type Call } from "./helpers.js";

// In-memory OS keychain, keyed by account, and a token on stdin.
const keychain = new Map<string, string>();
let stdin = "";
vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    constructor(_service: string, private account: string) {}
    getPassword(): string | null {
      return keychain.get(this.account) ?? null;
    }
    setPassword(value: string): void {
      keychain.set(this.account, value);
    }
    deletePassword(): boolean {
      return keychain.delete(this.account);
    }
  },
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: ((path: unknown, ...rest: unknown[]) => (path === 0 ? stdin : (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest))) as typeof actual.readFileSync };
});

const WORK = "robin@work.example.test";
const CLIENT = "robin@client.example.test";

function config(): Record<string, unknown> {
  return JSON.parse(realRead(join(process.env["BB_AXI_CONFIG_DIR"]!, "config.json"), "utf-8")) as Record<string, unknown>;
}

function emailOf(call: Call | undefined): string {
  const header = call?.headers["Authorization"] ?? "";
  return Buffer.from(header.replace(/^Basic /, ""), "base64").toString("utf-8").split(":")[0]!;
}

async function login(email: string, ...extra: string[]): Promise<string> {
  stdin = `token-for-${email}\n`;
  return (await run("auth", "login", "--email", email, "--token-stdin", ...extra)).stdout;
}

beforeEach(() => {
  useTestEnv();
  delete process.env["BITBUCKET_EMAIL"];
  delete process.env["BITBUCKET_API_TOKEN"];
  delete process.env["BB_AXI_NO_KEYCHAIN"];
  delete process.env["BB_AXI_PROFILE"];
  keychain.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("profiles", () => {
  it("login stores one token per profile and makes it active", async () => {
    mockApi([]);
    expect(await login(WORK)).toContain("profile: default");
    expect(await login(CLIENT, "--profile", "client")).toContain("profile: client");
    expect([...keychain.keys()].sort()).toEqual(["client", "default"]);
    expect(config()["active"]).toBe("client");

    const status = await run("auth", "status");
    expect(status.stdout).toContain("profiles[2]{name,email,active}:");
    expect(status.stdout).toContain("profile client");
  });

  it("-p, BB_AXI_PROFILE and the active profile pick the account, in that order", async () => {
    mockApi([]);
    await login(WORK, "--profile", "work");
    await login(CLIENT, "--profile", "client");
    const { calls } = mockApi([{ path: BASE, json: { slug: "widgets" } }]);
    const last = (): Call | undefined => calls.filter((c) => c.path === BASE).at(-1);

    await run("repo", "view", ...REPO);
    expect(emailOf(last())).toBe(CLIENT);
    process.env["BB_AXI_PROFILE"] = "work";
    await run("repo", "view", ...REPO);
    expect(emailOf(last())).toBe(WORK);
    await run("repo", "view", ...REPO, "-p", "client");
    expect(emailOf(last())).toBe(CLIENT);

    expect((await run("auth", "use", "work")).stdout).toContain("switched");
    delete process.env["BB_AXI_PROFILE"];
    await run("repo", "view", ...REPO);
    expect(emailOf(last())).toBe(WORK);
  });

  it("environment credentials win unless -p is given", async () => {
    mockApi([]);
    await login(WORK, "--profile", "work");
    process.env["BITBUCKET_EMAIL"] = "ci@example.test";
    process.env["BITBUCKET_API_TOKEN"] = "ci-token";
    const { calls } = mockApi([{ path: BASE, json: { slug: "widgets" } }]);
    await run("repo", "view", ...REPO);
    expect(emailOf(calls.at(-1))).toBe("ci@example.test");
    await run("repo", "view", ...REPO, "--profile=work");
    expect(emailOf(calls.at(-1))).toBe(WORK);
  });

  it("an unknown -p is a usage error listing the profiles", async () => {
    mockApi([]);
    await login(WORK, "--profile", "work");
    const { stdout, exitCode } = await run("repo", "view", ...REPO, "-p", "nope");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("no profile 'nope'");
    expect(stdout).toContain("profiles: work");
  });

  it("suggestions carry an explicit -p", async () => {
    mockApi([]);
    await login(WORK, "--profile", "work");
    mockApi([{ path: `${BASE}/pullrequests`, json: { values: [], size: 0 } }]);
    expect((await run("pr", "list", ...REPO, "-p", "work")).stdout).toContain("-R acme/widgets -p work");
  });

  it("a pre-profile login keeps working as the 'default' profile", async () => {
    writeFileSync(join(process.env["BB_AXI_CONFIG_DIR"]!, "config.json"), JSON.stringify({ email: WORK }));
    keychain.set(WORK, "legacy-token");
    const { calls } = mockApi([{ path: BASE, json: { slug: "widgets" } }]);
    await run("repo", "view", ...REPO);
    expect(emailOf(calls.at(-1))).toBe(WORK);

    // A fresh login moves the token to the profile name.
    await login(WORK);
    expect([...keychain.keys()]).toEqual(["default"]);
    expect(config()).toMatchObject({ active: "default", profiles: { default: { email: WORK } } });
  });

  it("logout removes the profile and its token, idempotently", async () => {
    mockApi([]);
    await login(WORK, "--profile", "work");
    await login(CLIENT, "--profile", "client");
    const out = (await run("auth", "logout", "--profile", "client")).stdout;
    expect(out).toContain("token removed");
    expect(out).toContain("active: work");
    expect([...keychain.keys()]).toEqual(["work"]);
    expect((await run("auth", "logout", "--profile", "client")).stdout).toContain("(no-op)");
  });

  it("rejects a profile name that is not a plain word", async () => {
    mockApi([]);
    stdin = "t\n";
    const { exitCode, stdout } = await run("auth", "login", "--email", WORK, "--token-stdin", "--profile", "a b");
    expect(exitCode).toBe(2);
    expect(stdout).toContain("invalid profile name");
  });
});
