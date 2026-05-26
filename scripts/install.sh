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
export MAESTRO_SKIP_EMBED_CHECK=1
pnpm build

# Offer embedding classifier (~400 MB optional peer).
# Skip prompt in non-interactive environments (CI, piped stdin).
if [[ -t 0 ]]; then
  echo ""
  echo "→ Embedding classifier (optional, ~400 MB)"
  echo "  Catches ambiguous prompts locally instead of burning an LLM call."
  echo "  Recommended for heavy users (50+ prompts/day)."
  read -r -p "  Install @xenova/transformers? [y/N] " _embed_reply
  if [[ "${_embed_reply,,}" == "y" ]]; then
    npm install -g @xenova/transformers
    echo "  Embedding classifier enabled."
  else
    echo "  Skipped. Install later with: npm install -g @xenova/transformers"
  fi
  echo ""
fi

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

echo "→ Installing Claude Code slash commands…"
maestro install-commands

echo "→ Writing cost-saving defaults (idempotent)…"
maestro install-defaults

maestro guide
echo ""
echo "Uninstall any time with:  bash scripts/install.sh --uninstall"
