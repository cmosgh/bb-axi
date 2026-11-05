import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** Cursor's sessionStart hook expects JSON on stdout, so it calls this adapter instead of the bare dashboard. */
export const CURSOR_HOOK_ACTION = "cursor-hook";
const MARKER = "bb-axi";

interface CursorHookEntry {
  command?: string;
  [key: string]: unknown;
}

export interface CursorHooks {
  version?: number;
  hooks?: Record<string, CursorHookEntry[] | undefined>;
  [key: string]: unknown;
}

export function cursorHooksPath(scope: "user" | "project", projectDir: string): string {
  return scope === "user" ? join(homedir(), ".cursor", "hooks.json") : join(projectDir, ".cursor", "hooks.json");
}

const isOurs = (entry: CursorHookEntry): boolean =>
  typeof entry.command === "string" && entry.command.includes(MARKER) && entry.command.endsWith(`setup ${CURSOR_HOOK_ACTION}`);

export function cursorHookInstalled(config: CursorHooks): boolean {
  return (config.hooks?.["sessionStart"] ?? []).some(isOurs);
}

/** Replaces any earlier bb-axi entry; other hooks are kept as they are. */
export function computeCursorHookUpdate(config: CursorHooks, command: string): [CursorHooks, boolean] {
  const entries = config.hooks?.["sessionStart"] ?? [];
  const entry = { command, timeout: 15 };
  const current = entries.filter(isOurs);
  if (current.length === 1 && current[0]!.command === command && current[0]!["timeout"] === entry.timeout) return [config, false];
  const sessionStart = [...entries.filter((e) => !isOurs(e)), entry];
  return [{ ...config, version: config.version ?? 1, hooks: { ...config.hooks, sessionStart } }, true];
}

export function computeCursorHookRemoval(config: CursorHooks): [CursorHooks, boolean] {
  const entries = config.hooks?.["sessionStart"] ?? [];
  const kept = entries.filter((e) => !isOurs(e));
  if (kept.length === entries.length) return [config, false];
  const { sessionStart: _, ...others } = config.hooks ?? {};
  return [{ ...config, hooks: kept.length > 0 ? { ...others, sessionStart: kept } : others }, true];
}

export function readCursorHooks(path: string): CursorHooks {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as CursorHooks;
}

export function writeCursorHooks(path: string, config: CursorHooks): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** `bb-axi` when PATH resolves to this same install (portable), else the absolute path of the binary. */
export function cursorHookCommand(execPath: string): string {
  const real = (path: string): string | undefined => {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  };
  const target = real(execPath);
  const onPath = (process.env["PATH"] ?? "").split(delimiter).some((dir) => dir && target !== undefined && real(join(dir, MARKER)) === target);
  const binary = onPath ? MARKER : /\s/.test(execPath) ? `"${execPath}"` : execPath;
  return `${binary} setup ${CURSOR_HOOK_ACTION}`;
}

/** The workspace Cursor opened: user-level hooks run from ~/.cursor, not the project. */
export function cursorWorkspaceRoot(env: NodeJS.ProcessEnv, stdin: () => string): string | undefined {
  const fromEnv = env["CURSOR_PROJECT_DIR"];
  if (fromEnv) return fromEnv;
  try {
    const roots = (JSON.parse(stdin()) as { workspace_roots?: unknown }).workspace_roots;
    return Array.isArray(roots) && typeof roots[0] === "string" ? roots[0] : undefined;
  } catch {
    return undefined;
  }
}
