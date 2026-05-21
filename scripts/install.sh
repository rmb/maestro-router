#!/usr/bin/env bash
# Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
#
# One-shot installer:
#   1. build maestro from this checkout
#   2. install globally via npm (from the freshly-packed tarball)
#   3. wire VSCode's claudeProcessWrapper to point at maestro
#
# Usage:   bash scripts/install.sh
# Uninstall: bash scripts/install.sh --uninstall

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--uninstall" ]]; then
  echo "→ Removing claudeProcessWrapper setting from VSCode…"
  if command -v maestro >/dev/null 2>&1; then
    maestro install-vscode --uninstall
  fi
  echo "→ Uninstalling maestro-router…"
  npm uninstall -g maestro-router || true
  echo ""
  echo "Done. Reload your VSCode window to drop the wrapper:"
  echo "  Cmd+Shift+P → 'Developer: Reload Window'"
  exit 0
fi

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required tool: $1" >&2
    exit 1
  fi
}

require node
require npm
require pnpm
require claude

echo "→ Verifying Claude CLI auth…"
if ! claude auth status >/dev/null 2>&1; then
  echo "  Claude CLI not authenticated. Run \`claude /login\` first." >&2
  exit 1
fi

echo "→ Installing dev dependencies (pnpm)…"
pnpm install --ignore-scripts

echo "→ Building…"
# The embedding classifier (S2) is an optional peer (@xenova/transformers).
# By default it isn't installed, so exemplars.json hasn't been generated yet
# and the prebuild checksum gate would fail. The runtime classifier degrades
# gracefully without exemplars (returns null + diagnostic, pipeline continues).
# Users who want embedding can opt in later:
#   npm install -g @xenova/transformers && pnpm embed
export MAESTRO_SKIP_EMBED_CHECK=1
pnpm build

echo "→ Packing tarball…"
rm -f maestro-router-*.tgz
pnpm pack >/dev/null
TARBALL=$(ls maestro-router-*.tgz | head -1)
echo "  → $TARBALL"

echo "→ Installing maestro globally…"
npm install -g "./$TARBALL"

echo "→ Verifying install…"
maestro --version
echo "  binary: $(which maestro)"

echo "→ Wiring VSCode (claudeProcessWrapper)…"
maestro install-vscode

echo ""
echo "✓ Done."
echo ""
echo "Next steps:"
echo "  1. Reload your VSCode window:"
echo "     Cmd+Shift+P → 'Developer: Reload Window'"
echo "  2. Use Claude Code in VSCode as normal — every prompt now auto-routes"
echo "     through Maestro."
echo "  3. Check savings later with:  maestro stats"
echo ""
echo "Uninstall any time with:  bash scripts/install.sh --uninstall"
