// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  ALL_CLASSES,
  applyOverrides,
  balancedProfile,
  builtinProfiles,
  cheapProfile,
  createProfile,
  loadProfile,
  qualityProfile,
} from "./profile.js";
import type { Class, ClassSpec, Profile } from "./types.js";

const fullClasses = (spec: ClassSpec): Record<Class, ClassSpec> => ({
  trivial: spec,
  simple: spec,
  standard: spec,
  hard: spec,
  reasoning: spec,
  max: spec,
});

describe("builtin profiles", () => {
  test("balanced has spec for every class", () => {
    for (const cls of ALL_CLASSES) {
      expect(balancedProfile.classes[cls]).toBeDefined();
    }
  });

  test("cheap profile uses cheaper models than balanced for mid tiers", () => {
    expect(cheapProfile.classes.simple.model).toBe("haiku");
    expect(balancedProfile.classes.simple.model).toBe("sonnet");
  });

  test("quality profile uses opus more often than balanced", () => {
    expect(qualityProfile.classes.hard.model).toBe("opus");
    expect(balancedProfile.classes.hard.model).toBe("sonnet");
  });

  test("balanced trivial has --bare and restricted tools", () => {
    const t = balancedProfile.classes.trivial;
    expect(t.bare).toBe(true);
    expect(t.tools).toBe("Read,Edit");
    expect(t.mcpConfig).toBe("{}");
  });

  test("balanced standard+ uses full tools and no --bare", () => {
    for (const cls of ["standard", "hard", "reasoning", "max"] as Class[]) {
      const spec = balancedProfile.classes[cls];
      expect(spec.tools).toBe("default");
      expect(spec.bare).toBeUndefined();
    }
  });

  test("builtinProfiles map exposes all three", () => {
    expect(Object.keys(builtinProfiles).sort()).toEqual([
      "balanced",
      "cheap",
      "quality",
    ]);
  });
});

describe("createProfile", () => {
  test("returns Profile when all classes specified", () => {
    const spec: ClassSpec = { model: "haiku", effort: "low", maxBudgetUsd: 0.1 };
    const p = createProfile({ name: "test", classes: fullClasses(spec) });
    expect(p.name).toBe("test");
    expect(p.classes.trivial.model).toBe("haiku");
  });

  test("rejects empty name", () => {
    const spec: ClassSpec = { model: "haiku", effort: "low", maxBudgetUsd: 0.1 };
    expect(() => createProfile({ name: "", classes: fullClasses(spec) })).toThrow(
      /non-empty string/,
    );
  });

  test("rejects missing class", () => {
    const partial = {
      trivial: { model: "haiku", effort: "low", maxBudgetUsd: 0.1 } as ClassSpec,
    } as Record<Class, ClassSpec>;
    expect(() => createProfile({ name: "test", classes: partial })).toThrow(
      /missing spec for class "simple"/,
    );
  });
});

describe("applyOverrides", () => {
  test("merges per-class overrides on top of base", () => {
    const result = applyOverrides(balancedProfile, {
      standard: { maxBudgetUsd: 1.5 },
    });
    expect(result.classes.standard.maxBudgetUsd).toBe(1.5);
    expect(result.classes.standard.model).toBe("sonnet"); // preserved
    expect(result.classes.trivial.maxBudgetUsd).toBe(0.05); // untouched
  });

  test("does not mutate base", () => {
    const before = balancedProfile.classes.standard.maxBudgetUsd;
    applyOverrides(balancedProfile, { standard: { maxBudgetUsd: 99 } });
    expect(balancedProfile.classes.standard.maxBudgetUsd).toBe(before);
  });

  test("noop when no overrides", () => {
    const result = applyOverrides(balancedProfile, {});
    expect(result.classes).toEqual(balancedProfile.classes);
  });
});

describe("loadProfile", () => {
  test("defaults to balanced when no profile name", () => {
    const loaded = loadProfile();
    expect(loaded.profile.name).toBe("balanced");
  });

  test("respects userConfig.profile", () => {
    const loaded = loadProfile({ userConfig: { profile: "cheap" } });
    expect(loaded.profile.name).toBe("cheap");
  });

  test("explicit profileName beats userConfig.profile", () => {
    const loaded = loadProfile({
      profileName: "quality",
      userConfig: { profile: "cheap" },
    });
    expect(loaded.profile.name).toBe("quality");
  });

  test("applies overrides", () => {
    const loaded = loadProfile({
      overrides: { hard: { maxBudgetUsd: 99 } },
    });
    expect(loaded.profile.classes.hard.maxBudgetUsd).toBe(99);
  });

  test("S7: applies global excludeDynamicSections default (true) to specs without explicit setting", () => {
    const loaded = loadProfile();
    for (const cls of ALL_CLASSES) {
      expect(loaded.profile.classes[cls].excludeDynamicSections).toBe(true);
    }
  });

  test("S7: respects userConfig.excludeDynamicSections=false", () => {
    const loaded = loadProfile({ userConfig: { excludeDynamicSections: false } });
    for (const cls of ALL_CLASSES) {
      expect(loaded.profile.classes[cls].excludeDynamicSections).toBe(false);
    }
  });

  test("S7: per-class explicit setting overrides global default", () => {
    const loaded = loadProfile({
      userConfig: { excludeDynamicSections: false },
      overrides: { standard: { excludeDynamicSections: true } },
    });
    expect(loaded.profile.classes.standard.excludeDynamicSections).toBe(true);
    expect(loaded.profile.classes.trivial.excludeDynamicSections).toBe(false);
  });

  test("throws on unknown profile name", () => {
    expect(() => loadProfile({ profileName: "doesnotexist" })).toThrow(/unknown profile/);
  });

  test("returns userConfig in loaded result", () => {
    const userConfig = { profile: "cheap", aggressiveness: "conservative" as const };
    const loaded = loadProfile({ userConfig });
    expect(loaded.userConfig).toBe(userConfig);
  });
});

// Sanity: profiles never have a model that isn't one of haiku/sonnet/opus
test("all builtin profiles use only known model aliases", () => {
  const known = new Set(["haiku", "sonnet", "opus"]);
  for (const [, profile] of Object.entries(builtinProfiles) as [string, Profile][]) {
    for (const cls of ALL_CLASSES) {
      expect(known.has(profile.classes[cls].model)).toBe(true);
    }
  }
});
