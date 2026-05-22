// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

const REQUIRED_FLAGS: ReadonlyArray<string> = [
  "--print",
  "--model",
  "--effort",
  "--max-budget-usd",
  "--session-id",
  "--resume",
  "--output-format",
  "--bare",
  "--exclude-dynamic-system-prompt-sections",
  "--tools",
  "--strict-mcp-config",
  "--mcp-config",
];

const MIN_VERSION = "2.1.0";

export type PreflightResult = {
  ok: boolean;
  binary: string;
  version: string;
  missingFlags: ReadonlyArray<string>;
  /**
   * Auth method as reported by `claude auth status` (e.g. "claude.ai" for
   * OAuth/subscription, "apiKey" for ANTHROPIC_API_KEY). Empty string if
   * auth status could not be determined.
   */
  authMethod: string;
  /**
   * Whether --bare is usable with the current auth method. False on OAuth
   * because --bare explicitly skips keychain reads (per Claude CLI docs);
   * true only when auth is via ANTHROPIC_API_KEY.
   */
  bareSupported: boolean;
  /**
   * Whether the Claude CLI `--help` output advertises `--fast-mode`.
   * Populated during flag-verification; false on any early-return path.
   * Used by the fast-mode spike (scripts/fast-mode-spike.ts) and, if the
   * spike confirms cost savings, by a future production integration.
   */
  fastModeAvailable?: boolean;
  reason?: string;
};

export type SpawnLike = (
  cmd: string,
  args: ReadonlyArray<string>,
) => { status: number | null; stdout: string; error?: Error };

export type PreflightOptions = {
  binary?: string;
  spawn?: SpawnLike;
};

const defaultSpawn: SpawnLike = (cmd, args) => {
  const res = spawnSync(cmd, [...args], { encoding: "utf8" });
  const out: { status: number | null; stdout: string; error?: Error } = {
    status: res.status,
    stdout: typeof res.stdout === "string" ? res.stdout : "",
  };
  if (res.error) out.error = res.error;
  return out;
};

/**
 * Verify the Claude CLI is installed, recent enough, and exposes every flag
 * Maestro depends on. Returns a structured result (does not throw) so callers
 * can format the upgrade message however they like.
 */
export function preflight(opts: PreflightOptions = {}): PreflightResult {
  const binary = opts.binary ?? "claude";
  const spawn = opts.spawn ?? defaultSpawn;

  const versionRes = spawn(binary, ["--version"]);
  if (versionRes.error || versionRes.status !== 0) {
    return {
      ok: false,
      binary,
      version: "",
      missingFlags: [],
      authMethod: "",
      bareSupported: false,
      fastModeAvailable: false,
      reason: `Claude CLI not found at '${binary}'. Install: https://docs.claude.com`,
    };
  }
  const version = parseVersion(versionRes.stdout);
  if (!version) {
    return {
      ok: false,
      binary,
      version: "",
      missingFlags: [],
      authMethod: "",
      bareSupported: false,
      fastModeAvailable: false,
      reason: `Could not parse Claude CLI version from '${versionRes.stdout.trim()}'`,
    };
  }
  if (!satisfiesMinimum(version, MIN_VERSION)) {
    return {
      ok: false,
      binary,
      version,
      missingFlags: [],
      authMethod: "",
      bareSupported: false,
      fastModeAvailable: false,
      reason: `Claude CLI ${version} is below the required minimum ${MIN_VERSION}. Run \`claude install\` to upgrade.`,
    };
  }

  const helpRes = spawn(binary, ["--help"]);
  if (helpRes.error || helpRes.status !== 0) {
    return {
      ok: false,
      binary,
      version,
      missingFlags: [],
      authMethod: "",
      bareSupported: false,
      fastModeAvailable: false,
      reason: "Could not retrieve Claude CLI --help output to verify flags",
    };
  }
  const missing = REQUIRED_FLAGS.filter((flag) => !helpRes.stdout.includes(flag));
  const fastModeAvailable = helpRes.stdout.includes("--fast-mode");
  if (missing.length > 0) {
    return {
      ok: false,
      binary,
      version,
      missingFlags: missing,
      authMethod: "",
      bareSupported: false,
      fastModeAvailable: false,
      reason: `Required flags not exposed by this Claude CLI: ${missing.join(", ")}. Run \`claude install\` to upgrade.`,
    };
  }

  // Detect auth method. --bare is incompatible with OAuth (claude.ai login)
  // because it skips keychain reads — so we must avoid emitting --bare for
  // subscription users. API-key auth (ANTHROPIC_API_KEY) keeps the savings.
  const auth = detectAuth(spawn, binary);
  return {
    ok: true,
    binary,
    version,
    missingFlags: [],
    authMethod: auth.method,
    bareSupported: auth.bareSupported,
    fastModeAvailable,
  };
}

function detectAuth(spawn: SpawnLike, binary: string): { method: string; bareSupported: boolean } {
  const res = spawn(binary, ["auth", "status"]);
  if (res.error || res.status !== 0) {
    return { method: "", bareSupported: false };
  }
  // `claude auth status` prints JSON. Parse defensively.
  const parsed = tryParseJson(res.stdout);
  const method = typeof parsed?.authMethod === "string" ? parsed.authMethod : "";
  // --bare requires API key per Claude CLI docs ("OAuth and keychain are never read").
  const bareSupported = method === "apiKey" || process.env.ANTHROPIC_API_KEY !== undefined;
  return { method, bareSupported };
}

function tryParseJson(s: string): { authMethod?: unknown } | null {
  try {
    const obj: unknown = JSON.parse(s);
    return typeof obj === "object" && obj !== null ? (obj as { authMethod?: unknown }) : null;
  } catch {
    return null;
  }
}

export function parseVersion(text: string): string | null {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function satisfiesMinimum(actual: string, minimum: string): boolean {
  const a = actual.split(".").map(Number);
  const m = minimum.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, m.length); i++) {
    const av = a[i] ?? 0;
    const mv = m[i] ?? 0;
    if (av > mv) return true;
    if (av < mv) return false;
  }
  return true;
}
