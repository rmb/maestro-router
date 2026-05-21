#!/bin/sh
# Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
#
# Maestro Stop-hook: after Claude Code finishes a response, optionally
# prompt the user for a 1-5 quality rating and record it via
# `maestro telemetry feedback <sid> --rating <n> --auto`.
#
# Triggered by Claude Code's Stop event. stdin is a JSON blob; stdout/stderr
# are pipes to Claude Code, so we must use /dev/tty for any user
# interaction.
#
# Sampling controlled by ~/.maestro/config.json:
#   feedbackPrompts: "never" | "occasional" | "always"   (default "never")
#   feedbackSampleRate: 0..1                              (default 0.2)
#
# POSIX sh — must work on macOS bash and Linux dash. No bashisms.
# Never blocks the hook chain: every branch exits 0 on failure.

set -u

# Read all of stdin into a variable (the Stop hook JSON blob). If reading
# fails for any reason we still exit 0.
INPUT=$(cat 2>/dev/null) || exit 0

CONFIG_FILE="${MAESTRO_CONFIG:-${HOME}/.maestro/config.json}"

# --- Extract a JSON string field, jq-first with a brittle grep fallback. ---
# Args: $1=json text, $2=field name. Echoes value or empty.
json_string() {
  _json=$1
  _key=$2
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$_json" | jq -r --arg k "$_key" '.[$k] // empty' 2>/dev/null
    return
  fi
  # Fallback: extract "key": "value" with grep+sed. Brittle on escaped
  # quotes inside the string but adequate for session_id / mode fields
  # which Claude Code emits as plain UUIDs / lowercase identifiers.
  printf '%s' "$_json" \
    | grep -o "\"$_key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -n1 \
    | sed -E "s/.*\"$_key\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\\1/"
}

# Args: $1=json text, $2=field name. Echoes numeric value or empty.
json_number() {
  _json=$1
  _key=$2
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$_json" | jq -r --arg k "$_key" '.[$k] // empty' 2>/dev/null
    return
  fi
  printf '%s' "$_json" \
    | grep -o "\"$_key\"[[:space:]]*:[[:space:]]*[0-9]*\\.\\{0,1\\}[0-9]*" \
    | head -n1 \
    | sed -E "s/.*\"$_key\"[[:space:]]*:[[:space:]]*([0-9]+\\.?[0-9]*).*/\\1/"
}

# Read config (missing file → empty config, defaults apply).
CONFIG=""
if [ -r "$CONFIG_FILE" ]; then
  CONFIG=$(cat "$CONFIG_FILE" 2>/dev/null) || CONFIG=""
fi

MODE=""
if [ -n "$CONFIG" ]; then
  MODE=$(json_string "$CONFIG" "feedbackPrompts") || MODE=""
fi
# Default behavior is silent: never prompt unless the user opted in.
[ -z "$MODE" ] && MODE="never"

case "$MODE" in
  never)
    exit 0
    ;;
  always)
    : # fall through to prompt
    ;;
  occasional)
    RATE=""
    if [ -n "$CONFIG" ]; then
      RATE=$(json_number "$CONFIG" "feedbackSampleRate") || RATE=""
    fi
    [ -z "$RATE" ] && RATE="0.2"
    # Sample via awk (POSIX): roll a [0,1) random, compare to RATE.
    KEEP=$(awk -v r="$RATE" 'BEGIN { srand(); if (rand() < r+0) print 1; else print 0 }') \
      || KEEP=0
    [ "$KEEP" = "1" ] || exit 0
    ;;
  *)
    # Unknown mode: treat as never.
    exit 0
    ;;
esac

# Extract session id for the feedback record.
SID=$(json_string "$INPUT" "session_id") || SID=""
[ -z "$SID" ] && exit 0

# Interactive I/O via /dev/tty. If unavailable (non-interactive run), bail.
if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
  exit 0
fi

printf '[maestro] How was that response? (1-5, q to skip): ' >/dev/tty 2>/dev/null \
  || exit 0

# Read exactly one character. `read -n 1` is bash-only; `dd` is portable.
CHAR=$(dd bs=1 count=1 2>/dev/null </dev/tty) || CHAR=""
printf '\n' >/dev/tty 2>/dev/null

case "$CHAR" in
  1|2|3|4|5)
    RATING="$CHAR"
    ;;
  *)
    exit 0
    ;;
esac

# Find a maestro binary. Prefer one alongside this script's parent (when
# the script was installed inside ~/.maestro/hooks/, no help); otherwise
# rely on PATH.
MAESTRO_BIN="${MAESTRO_BIN:-maestro}"
if ! command -v "$MAESTRO_BIN" >/dev/null 2>&1; then
  exit 0
fi

# Record. Run quietly and silence all output to keep the hook chain clean.
"$MAESTRO_BIN" telemetry feedback "$SID" --rating "$RATING" --auto \
  >/dev/null 2>&1 || true

exit 0
