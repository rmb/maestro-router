# Lessons

Captured during the build. Each entry: one line, the rule + brief why.

## Bootstrap

- pnpm 11 fails install when any dep has unapproved build scripts (esbuild's postinstall). Bypass with `pnpm install --ignore-scripts`. Vitest works without esbuild's prebuilt binary — it bundles its own at runtime. Add `--ignore-scripts` to README install instructions.
- pnpm 11's `pnpm-workspace.yaml` `onlyBuiltDependencies` setting did not take effect for the single-package case in this environment. `.npmrc` `only-built-dependencies[]` also ignored. `--ignore-scripts` flag is the working workaround.

## Classifiers

- Classifier failure paths return `null` (per codebase convention), so attaching `diagnostics` to the null is impossible. Surface fallback codes via an injectable `diagnosticSink` (default writes to `process.stderr`). Tests assert on the sink, not on the Classification.
