import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  installSessionStartHooks,
  sessionStartHookStatus,
  shouldInstallHooksForNodeAxiExecPath,
  uninstallSessionStartHooks,
} from "axi-sdk-js";
import { bool, expectPositionals, parseArgs } from "../args.js";
import { resolveRepo } from "../context.js";
import {
  computeCursorHookRemoval,
  computeCursorHookUpdate,
  CURSOR_HOOK_ACTION,
  cursorHookCommand,
  cursorHookInstalled,
  cursorHooksPath,
  cursorWorkspaceRoot,
  readCursorHooks,
  writeCursorHooks,
  type CursorHooks,
} from "../cursor.js";
import { axiError, usageError } from "../errors.js";
import { block, helpBlock, out } from "../render.js";
import { homeCommand } from "./home.js";

type Scope = "user" | "project";

export const SETUP_HELP = `usage: bb-axi setup <hooks|status|uninstall> [--project]
Manage the opt-in SessionStart integration that shows the bb-axi review dashboard to Claude Code, Codex, OpenCode and Cursor at session start.
flags:
  --project (install into the current repository's agent config instead of your user config)
notes:
  User scope runs in every session; outside Bitbucket checkouts the dashboard is two lines and makes no network calls.
  Cursor runs \`bb-axi setup ${CURSOR_HOOK_ACTION}\` from ~/.cursor/hooks.json or .cursor/hooks.json; it prints the dashboard as JSON.
examples[3]:
  bb-axi setup hooks
  bb-axi setup hooks --project
  bb-axi setup status
`;

const IDENTITY = { marker: "bb-axi", binaryNames: ["bb-axi"] };

export async function setupCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === CURSOR_HOOK_ACTION) {
    expectPositionals(parseArgs(rest, [], `bb-axi setup ${sub}`), 0, `bb-axi setup ${sub}`);
    return cursorHookOutput();
  }
  if (sub !== "hooks" && sub !== "status" && sub !== "uninstall") {
    throw usageError(sub ? `unknown setup action '${sub}'` : "missing setup action", [
      "Run `bb-axi setup hooks` to install, `bb-axi setup status` to inspect, `bb-axi setup uninstall` to remove",
    ]);
  }
  const command = `bb-axi setup ${sub}`;
  const parsed = parseArgs(rest, [{ name: "--project", boolean: true }], command);
  expectPositionals(parsed, 0, `${command} [--project]`);
  const scope: Scope = bool(parsed, "--project") ? "project" : "user";

  if (sub === "status") {
    const status = sessionStartHookStatus({ ...IDENTITY, scope });
    return block({
      hooks: {
        scope,
        claude_code: status.claude.installed ? "installed" : "not installed",
        codex: status.codex.installed ? "installed" : "not installed",
        opencode: status.opencode.installed ? "installed" : "not installed",
        cursor: cursorInstalled(scope) ? "installed" : "not installed",
      },
    });
  }

  if (sub === "uninstall") {
    const errors: string[] = [];
    uninstallSessionStartHooks({ ...IDENTITY, scope, onError: (message) => errors.push(message) });
    withCursorHooks(scope, errors, (config) => computeCursorHookRemoval(config));
    const left = installedAgents(scope);
    if (errors.length > 0 || left.length > 0) {
      throw axiError(`hooks not fully removed${left.length > 0 ? ` (still installed: ${left.join("; ")})` : ""}`, "SETUP_FAILED", errors);
    }
    return block({ hooks: { scope, status: "removed (or were not installed)" } });
  }

  // The SDK silently skips non-installed exec paths and reports write failures only via onError, so verify by re-reading.
  const errors: string[] = [];
  installSessionStartHooks({ ...IDENTITY, scope, onError: (message) => errors.push(message) });
  const execPath = resolve(process.argv[1] ?? "");
  if (shouldInstallHooksForNodeAxiExecPath(execPath, IDENTITY)) {
    withCursorHooks(scope, errors, (config) => computeCursorHookUpdate(config, cursorHookCommand(execPath)));
  }
  const installed = installedAgents(scope);
  if (installed.length === 0) {
    throw axiError("no hooks were installed", "SETUP_FAILED", errors.length > 0 ? errors : [
      "Hooks are only installed from the npm-installed binary: run `npm i -g bb-axi`, then `bb-axi setup hooks`",
    ]);
  }
  if (errors.length > 0 || installed.length < 4) {
    throw axiError(`hooks only partly installed (installed: ${installed.join("; ")})`, "SETUP_FAILED", errors);
  }
  return out(
    block({ hooks: { scope, status: "installed", integrations: installed.join("; ") } }),
    helpBlock(["Restart the agent session to receive the bb-axi dashboard as ambient context"]),
  );
}

function installedAgents(scope: Scope): string[] {
  const status = sessionStartHookStatus({ ...IDENTITY, scope });
  const agents: Array<[string, boolean]> = [
    ["Claude Code", status.claude.installed],
    ["Codex", status.codex.installed],
    ["OpenCode", status.opencode.installed],
    ["Cursor", cursorInstalled(scope)],
  ];
  return agents.filter(([, installed]) => installed).map(([agent]) => agent);
}

function cursorInstalled(scope: Scope): boolean {
  try {
    return cursorHookInstalled(readCursorHooks(cursorHooksPath(scope, process.cwd())));
  } catch {
    return false;
  }
}

/** Read-modify-write of Cursor's hooks.json; failures are reported like the SDK's, never thrown. */
function withCursorHooks(scope: Scope, errors: string[], change: (config: CursorHooks) => [CursorHooks, boolean]): void {
  const path = cursorHooksPath(scope, process.cwd());
  try {
    const [updated, changed] = change(readCursorHooks(path));
    if (changed) writeCursorHooks(path, updated);
  } catch (error) {
    errors.push(`Cursor: ${path} - ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Cursor's sessionStart contract: JSON with additional_context; any failure stays silent. */
async function cursorHookOutput(): Promise<string> {
  try {
    const root = cursorWorkspaceRoot(process.env, () => (process.stdin.isTTY ? "" : readFileSync(0, "utf-8")));
    if (root && existsSync(root)) process.chdir(root);
    return JSON.stringify({ additional_context: await homeCommand([], resolveRepo()) });
  } catch {
    return "{}";
  }
}
