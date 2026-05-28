// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { ConfigValidationError, parseUserConfig } from "./config-schema.js";

describe("parseUserConfig", () => {
  test("valid config parses without error", () => {
    const input = {
      profile: "power",
      aggressiveness: "balanced",
      dailyCostCapUsd: 5,
      autoCompact: true,
      useLlmClassifier: false,
      feedbackPrompts: "never",
      telemetry: { eventsLogged: 42, lastWriteAt: "2026-01-01" },
    };
    const result = parseUserConfig(input);
    expect(result.profile).toBe("power");
    expect(result.dailyCostCapUsd).toBe(5);
    expect(result.autoCompact).toBe(true);
    expect(result.telemetry?.eventsLogged).toBe(42);
  });

  test("unknown keys are stripped", () => {
    const input = { autoCompact: true, unknownKey: "should-be-removed" };
    const result = parseUserConfig(input);
    expect(result.autoCompact).toBe(true);
    expect("unknownKey" in result).toBe(false);
  });

  test("wrong type for autoCompact throws ConfigValidationError mentioning autoCompact", () => {
    const input = { autoCompact: "yes" };
    expect(() => parseUserConfig(input)).toThrowError(ConfigValidationError);
    try {
      parseUserConfig(input);
    } catch (err) {
      expect((err as Error).message).toContain("autoCompact");
    }
  });

  test("wrong type for dailyCostCapUsd throws ConfigValidationError mentioning dailyCostCapUsd", () => {
    const input = { dailyCostCapUsd: "5.00" };
    expect(() => parseUserConfig(input)).toThrowError(ConfigValidationError);
    try {
      parseUserConfig(input);
    } catch (err) {
      expect((err as Error).message).toContain("dailyCostCapUsd");
    }
  });

  test("parseUserConfig({}) returns {} (all fields optional)", () => {
    const result = parseUserConfig({});
    expect(result).toEqual({});
  });

  test("handles nested telemetry object correctly", () => {
    const input = { telemetry: { eventsLogged: 10, lastWriteAt: null } };
    const result = parseUserConfig(input);
    expect(result.telemetry?.eventsLogged).toBe(10);
    expect(result.telemetry?.lastWriteAt).toBeNull();
  });

  test("wrong type inside nested telemetry throws ConfigValidationError", () => {
    const input = { telemetry: { eventsLogged: "not-a-number" } };
    expect(() => parseUserConfig(input)).toThrowError(ConfigValidationError);
    try {
      parseUserConfig(input);
    } catch (err) {
      expect((err as Error).message).toContain("telemetry");
    }
  });

  test("ConfigValidationError has correct name", () => {
    try {
      parseUserConfig({ autoCompact: "bad" });
    } catch (err) {
      expect((err as Error).name).toBe("ConfigValidationError");
    }
  });

  test("invalid enum value throws ConfigValidationError with readable message", () => {
    try {
      parseUserConfig({ aggressiveness: "extreme" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const msg = (err as Error).message;
      expect(msg).toContain("aggressiveness");
      expect(msg).toContain("conservative");
      expect(msg).not.toMatch(/expected Invalid enum/);
    }
  });
});
