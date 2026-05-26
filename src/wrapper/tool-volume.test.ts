// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  createToolVolumeState,
  incrementToolVolume,
  isHighVolumeTurn,
  resetToolVolume,
  upgradeModel,
} from "./tool-volume.js";

describe("tool-volume state", () => {
  test("createToolVolumeState starts at 0", () => {
    const state = createToolVolumeState();
    expect(state.toolCallsThisTurn).toBe(0);
  });

  test("resetToolVolume resets to 0", () => {
    const state = createToolVolumeState();
    incrementToolVolume(state, 5);
    resetToolVolume(state);
    expect(state.toolCallsThisTurn).toBe(0);
  });

  test("incrementToolVolume adds the given count", () => {
    const state = createToolVolumeState();
    incrementToolVolume(state, 3);
    expect(state.toolCallsThisTurn).toBe(3);
  });

  test("isHighVolumeTurn returns false at 3 (below threshold)", () => {
    const state = createToolVolumeState();
    incrementToolVolume(state, 3);
    expect(isHighVolumeTurn(state)).toBe(false);
  });

  test("isHighVolumeTurn returns true at 4 (at threshold)", () => {
    const state = createToolVolumeState();
    incrementToolVolume(state, 4);
    expect(isHighVolumeTurn(state)).toBe(true);
  });

  test("isHighVolumeTurn returns true at 5 (beyond threshold)", () => {
    const state = createToolVolumeState();
    incrementToolVolume(state, 5);
    expect(isHighVolumeTurn(state)).toBe(true);
  });
});

describe("upgradeModel", () => {
  test("upgrades haiku to sonnet", () => {
    expect(upgradeModel("haiku")).toBe("sonnet");
  });

  test("upgrades sonnet to opus", () => {
    expect(upgradeModel("sonnet")).toBe("opus");
  });

  test("opus is a no-op (already at top)", () => {
    expect(upgradeModel("opus")).toBe("opus");
  });

  test("upgrades full model name containing haiku", () => {
    expect(upgradeModel("claude-haiku-4-5-20251001")).toContain("sonnet");
  });

  test("unknown model is returned unchanged", () => {
    expect(upgradeModel("unknown-model")).toBe("unknown-model");
  });
});
