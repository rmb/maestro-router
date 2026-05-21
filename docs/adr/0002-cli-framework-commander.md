# ADR-0002 · CLI framework: Commander

## Status

Accepted · 2026-05-21

## Context

Maestro's v0.2 CLI exposes several commands: `stats`, `tune`, `replay`,
`bench`, `telemetry` (with subcommands `status`, `show`, `feedback`), and
the default "wrap a prompt" path. The CLI framework affects help output,
flag parsing, subcommand structure, and contributor familiarity.

## Decision

**Commander v12+** for the CLI shell.

## Rationale

- **Ubiquity**: Commander has 100M+ weekly downloads. Most Node CLI
  contributors have seen it before. Lowest cognitive overhead.
- **ESM since v10**: Native ESM support, no CJS interop dance.
- **Subcommands + flags + help**: Built-in coverage of the patterns
  Maestro needs (`maestro telemetry status`, `maestro bench --tournament`,
  `--json` flag on every command). No need to roll our own arg parser.
- **Self-registering pattern**: Each command file can export a
  `(program: Command) => void` that registers its command(s) with the
  parent program. Keeps `cli/index.ts` small.

## Alternatives considered

- **`yargs`** — comparable feature set, larger API surface. Commander
  wins on familiarity.
- **`clipanion`** — type-safe via classes, smaller ecosystem.
- **`@stricli/core`** — newer, stronger types, but smaller contributor
  pool.
- **Hand-rolled with `process.argv`** — fine for `--print` passthrough
  but the subcommand tree is enough to want a framework.

## Consequences

- Adding a new command means one new file in `src/cli/` that imports
  `Command` from commander and calls `program.command(...)`.
- Help output is consistent with the JS CLI ecosystem.
- Commander is an optional peer dependency declared in `package.json`,
  not a hard runtime dependency, so other consumers of `maestro-router`
  as a library don't pull it in.
