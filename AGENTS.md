# bb-axi - contributor notes for agents

AXI-compliant Bitbucket Cloud CLI. Read the AXI principles (https://axi.md) before changing output.

- **Output is the product.** Every stdout byte costs tokens. Default list schemas stay at 3-5 fields; extras go behind `--fields`. Avoid commas, colons and double quotes inside TOON string values - they force quoting/escaping (use `;`, ` - `, single quotes).
- **Handlers return strings** built with `block()` (TOON), `helpBlock()` (one suggestion per line) and `out()` from `src/render.ts`. Raw text (diffs, logs) goes between `---` fences, never inside a TOON string.
- **Every flag is declared.** `parseArgs()` in `src/args.ts` rejects unknown flags with the valid set inline. Validate all input before the first network call; usage errors are `VALIDATION_ERROR` (exit 2).
- **Mutations are idempotent** (pre-check state, report `(no-op)`, exit 0) and irreversible ones need `--confirm`, previewing otherwise.
- **Suggestions carry context**: append `repoHint(ctx)` so an explicit `-R` survives into the next command; use `<placeholders>` for runtime values.
- **The home view runs at every session start.** Outside a Bitbucket checkout it must not touch the network or the keychain.
- **Secrets**: tokens come from stdin or env only, live in the OS keychain, and are sent only to the configured API origin (`buildUrl()` in `src/client.ts`).
- `src/version.ts` is a leaf module (node builtins only) for the `--version` fast path.
- Tests: `test/unit.test.ts` (pure logic) and `test/commands.test.ts` (whole CLI via `main()` with a mocked `fetch`). Fixtures are synthetic - never commit real workspace, repository or people names.
- `pnpm run check` must pass. `skills/bb-axi/SKILL.md` is generated: `pnpm run build:skill`.
