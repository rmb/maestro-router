// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Class, ClassSpec, Profile, ProfileOverride, UserConfig } from "./types.js";

export const ALL_CLASSES: ReadonlyArray<Class> = [
  "trivial",
  "simple",
  "standard",
  "hard",
  "reasoning",
  "max",
];

/**
 * One-tier upgrade map. Used by the asymmetric-confidence safety net in
 * the pipeline: when a classifier is between SHORT_CIRCUIT and
 * HIGH_CONFIDENCE thresholds, the chosen class is upgraded by one tier so
 * a misroute lands UP (~$0.05 wasted on too-strong) rather than DOWN
 * (~$0.50 if Haiku can't handle the actual Opus-class task).
 *
 * `max` is the ceiling — there is nothing higher to bump to.
 */
export const UPGRADE: Record<Class, Class> = {
  trivial: "simple",
  simple: "standard",
  standard: "hard",
  hard: "reasoning",
  reasoning: "max",
  max: "max",
};

/** Default `balanced` profile per plan. Trivial uses --bare; all classes share tools="default" to unify sonnet fingerprints. */
export const balancedProfile: Profile = {
  name: "balanced",
  classes: {
    trivial: {
      model: "claude-haiku-4-5-20251001",
      effort: "low",
      tools: "Read,Edit",
      bare: true,
      mcpConfig: '{"mcpServers":{}}',
      maxBudgetUsd: 0.05,
      noPersist: true,
    },
    simple: {
      model: "claude-sonnet-4-6",
      effort: "low",
      tools: "default",
      mcpConfig: '{"mcpServers":{}}',
      maxBudgetUsd: 0.3,
    },
    // P8: standard/hard isolate inherited MCP servers (saves 3-10k cache_creation
    // tokens on machines with active MCP configs). Tools left as "default" — MCP
    // isolation is the cheaper win without restricting tool access.
    standard: { model: "claude-sonnet-4-6", effort: "low", tools: "default", mcpConfig: '{"mcpServers":{}}', maxBudgetUsd: 1.0, maxOutputTokens: 16000 },
    hard: { model: "claude-sonnet-4-6", effort: "high", tools: "default", mcpConfig: '{"mcpServers":{}}', maxBudgetUsd: 3.0, maxOutputTokens: 4000 },
    reasoning: { model: "claude-opus-4-8", effort: "xhigh", tools: "default", maxBudgetUsd: 5.0, maxOutputTokens: 6000 },
    max: { model: "claude-opus-4-8", effort: "high", tools: "default", maxBudgetUsd: 5.0 },
  },
};

/** Cost-biased profile — uses cheaper models where balanced uses Sonnet. */
export const cheapProfile: Profile = {
  name: "cheap",
  classes: {
    trivial: {
      model: "claude-haiku-4-5-20251001",
      effort: "low",
      tools: "Read,Edit",
      bare: true,
      mcpConfig: '{"mcpServers":{}}',
      maxBudgetUsd: 0.03,
      noPersist: true,
    },
    simple: {
      model: "claude-haiku-4-5-20251001",
      effort: "low",
      tools: "default",
      mcpConfig: '{"mcpServers":{}}',
      maxBudgetUsd: 0.1,
    },
    // P8: cheap profile also gets MCP isolation on standard/hard
    standard: { model: "claude-sonnet-4-6", effort: "low", tools: "default", mcpConfig: '{"mcpServers":{}}', maxBudgetUsd: 0.5 },
    hard: { model: "claude-sonnet-4-6", effort: "medium", tools: "default", mcpConfig: '{"mcpServers":{}}', maxBudgetUsd: 2.0 },
    reasoning: { model: "claude-sonnet-4-6", effort: "xhigh", tools: "default", maxBudgetUsd: 3.0 },
    max: { model: "claude-opus-4-8", effort: "high", tools: "default", maxBudgetUsd: 5.0 },
  },
};

/** Quality-biased profile — uses Opus/Fable more aggressively. */
export const qualityProfile: Profile = {
  name: "quality",
  classes: {
    trivial: {
      model: "claude-haiku-4-5-20251001",
      effort: "low",
      tools: "Read,Edit",
      bare: true,
      mcpConfig: '{"mcpServers":{}}',
      maxBudgetUsd: 0.1,
      noPersist: true,
    },
    simple: { model: "claude-sonnet-4-6", effort: "medium", tools: "default", mcpConfig: '{"mcpServers":{}}', maxBudgetUsd: 0.5 },
    standard: { model: "claude-sonnet-4-6", effort: "high", tools: "default", maxBudgetUsd: 2.0 },
    hard: { model: "claude-opus-4-8", effort: "high", tools: "default", maxBudgetUsd: 5.0 },
    reasoning: { model: "claude-fable-5", effort: "xhigh", tools: "default", maxBudgetUsd: 10.0 },
    max: { model: "claude-fable-5", effort: "max", tools: "default", maxBudgetUsd: 20.0 },
  },
};

export const builtinProfiles: Record<string, Profile> = {
  balanced: balancedProfile,
  cheap: cheapProfile,
  quality: qualityProfile,
};

export type CreateProfileArgs = {
  name: string;
  classes: Record<Class, ClassSpec>;
};

/** Build a Profile from a complete spec. Throws on missing class or empty name. */
export function createProfile(args: CreateProfileArgs): Profile {
  if (typeof args.name !== "string" || args.name.length === 0) {
    throw new Error("createProfile: name must be a non-empty string");
  }
  for (const cls of ALL_CLASSES) {
    if (!args.classes[cls]) {
      throw new Error(`createProfile: missing spec for class "${cls}"`);
    }
  }
  return { name: args.name, classes: { ...args.classes } };
}

/** Apply per-class partial overrides on top of a base profile. Pure. */
export function applyOverrides(base: Profile, overrides: ProfileOverride): Profile {
  const next: Record<Class, ClassSpec> = { ...base.classes };
  for (const cls of ALL_CLASSES) {
    const partial = overrides[cls];
    if (partial) {
      next[cls] = { ...next[cls], ...partial };
    }
  }
  return { name: base.name, classes: next };
}

export type LoadProfileOptions = {
  profileName?: string;
  userConfig?: UserConfig;
  overrides?: ProfileOverride;
};

export type LoadedProfile = {
  profile: Profile;
  userConfig: UserConfig;
};

/**
 * Compose a final profile from the layered config:
 *   builtin defaults → overrides → S7 global excludeDynamicSections default.
 * Filesystem discovery happens in cli/utils.ts (module 18); this function is pure.
 */
export function loadProfile(opts: LoadProfileOptions = {}): LoadedProfile {
  const userConfig = opts.userConfig ?? {};
  const name = opts.profileName ?? userConfig.profile ?? "balanced";
  const base = builtinProfiles[name];
  if (!base) {
    throw new Error(`unknown profile: "${name}"`);
  }
  const merged = opts.overrides ? applyOverrides(base, opts.overrides) : base;

  // S7: per-class `excludeDynamicSections` falls back to the global user pref (default true).
  const globalExclude = userConfig.excludeDynamicSections ?? true;
  const classes: Record<Class, ClassSpec> = {} as Record<Class, ClassSpec>;
  for (const cls of ALL_CLASSES) {
    const spec = merged.classes[cls];
    classes[cls] =
      spec.excludeDynamicSections === undefined
        ? { ...spec, excludeDynamicSections: globalExclude }
        : spec;
  }
  return { profile: { name: merged.name, classes }, userConfig };
}
