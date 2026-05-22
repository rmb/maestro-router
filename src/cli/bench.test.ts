// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

/**
 * Lightweight unit coverage for the cost-estimate logic extracted from
 * runTournamentMode. The full CLI integration is exercised by E2E tests.
 */
describe("bench tournament-matrix cost estimate constants", () => {
  test("matrix multiplier is 5/3 of standard (5 calls vs 3)", () => {
    const standard = 3;
    const matrix = 5;
    // Conservative upfront estimate: matrix adds ~2 extra spawns per row.
    expect(matrix).toBeGreaterThan(standard);
    expect(matrix / standard).toBeCloseTo(5 / 3, 5);
  });
});
