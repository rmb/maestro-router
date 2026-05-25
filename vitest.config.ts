// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Exclude stale worktree artifacts left by subagents — only test main src/
    exclude: [".claude/**", "node_modules/**", "dist/**"],
  },
});
