import { installSessionStartHooks, sessionStartHookStatus, uninstallSessionStartHooks } from "axi-sdk-js";
import { bool, expectPositionals, parseArgs } from "../args.js";
import { usageError } from "../errors.js";
import { block, helpBlock, out } from "../render.js";

export const SETUP_HELP = `usage: bb-axi setup <hooks|status|uninstall> [--project]
Manage the opt-in SessionStart integration that shows the bb-axi review dashboard to Claude Code, Codex and OpenCode at session start.
flags:
  --project (install into the current repository's agent config instead of your user config)
notes:
  User scope runs in every session; outside Bitbucket checkouts the dashboard is two lines and makes no network calls.
examples[3]:
  bb-axi setup hooks
  bb-axi setup hooks --project
  bb-axi setup status
`;

const IDENTITY = { marker: "bb-axi", binaryNames: ["bb-axi"] };

export async function setupCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub !== "hooks" && sub !== "status" && sub !== "uninstall") {
    throw usageError(sub ? `unknown setup action '${sub}'` : "missing setup action", [
      "Run `bb-axi setup hooks` to install, `bb-axi setup status` to inspect, `bb-axi setup uninstall` to remove",
    ]);
  }
  const command = `bb-axi setup ${sub}`;
  const parsed = parseArgs(rest, [{ name: "--project", boolean: true }], command);
  expectPositionals(parsed, 0, `${command} [--project]`);
  const scope = bool(parsed, "--project") ? "project" : "user";

  if (sub === "status") {
    const status = sessionStartHookStatus({ ...IDENTITY, scope });
    return block({
      hooks: {
        scope,
        claude_code: status.claude.installed ? "installed" : "not installed",
        codex: status.codex.installed ? "installed" : "not installed",
        opencode: status.opencode.installed ? "installed" : "not installed",
      },
    });
  }

  if (sub === "uninstall") {
    await uninstallSessionStartHooks({ ...IDENTITY, scope });
    return block({ hooks: { scope, status: "removed (or were not installed)" } });
  }

  await installSessionStartHooks({ ...IDENTITY, scope });
  return out(
    block({ hooks: { scope, status: "installed or already up to date", integrations: "Claude Code, Codex, OpenCode" } }),
    helpBlock(["Restart the agent session to receive the bb-axi dashboard as ambient context"]),
  );
}
