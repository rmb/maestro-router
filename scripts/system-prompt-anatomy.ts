#!/usr/bin/env tsx
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// Spike script (P11 / P13): empirically measure the system-prompt token
// floor under different Claude CLI flag combinations.
//
// Usage:  pnpm tsx scripts/system-prompt-anatomy.ts
//
// Runs `claude --print --output-format json "hi"` under N flag matrices on
// Haiku and tabulates cache_creation_input_tokens from the JSON envelope.
// Each run costs ~$0.001 on Haiku; full sweep ≈ $0.01.
//
// Output written to fast-mode-spike-results.json (or use --out <path>).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";

const exec = promisify(execFile);

type FlagMatrix = {
  label: string;
  args: string[];
};

const MATRIX: FlagMatrix[] = [
  { label: "default", args: [] },
  { label: "exclude-dynamic", args: ["--exclude-dynamic-system-prompt-sections"] },
  {
    label: "exclude+mcp-empty",
    args: [
      "--exclude-dynamic-system-prompt-sections",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
    ],
  },
  {
    label: "exclude+tools-empty",
    args: [
      "--exclude-dynamic-system-prompt-sections",
      "--tools",
      "",
    ],
  },
  {
    label: "exclude+disable-slash",
    args: [
      "--exclude-dynamic-system-prompt-sections",
      "--disable-slash-commands",
    ],
  },
  {
    label: "full-suppression",
    args: [
      "--exclude-dynamic-system-prompt-sections",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--tools",
      "",
      "--disable-slash-commands",
    ],
  },
  {
    label: "system-prompt-replace",
    args: [
      "--system-prompt",
      "You are Claude.",
    ],
  },
];

type Result = {
  label: string;
  cacheCreation: number | null;
  inputTokens: number | null;
  totalCostUsd: number | null;
  error?: string;
};

async function runOne(args: string[], label: string): Promise<Result> {
  try {
    const { stdout } = await exec(
      "claude",
      ["--print", "--output-format", "json", "--model", "haiku", ...args, "hi"],
      { timeout: 60_000 },
    );
    const obj = JSON.parse(stdout) as {
      usage?: {
        cache_creation_input_tokens?: number;
        input_tokens?: number;
      };
      total_cost_usd?: number;
    };
    return {
      label,
      cacheCreation: obj.usage?.cache_creation_input_tokens ?? null,
      inputTokens: obj.usage?.input_tokens ?? null,
      totalCostUsd: obj.total_cost_usd ?? null,
    };
  } catch (err) {
    return {
      label,
      cacheCreation: null,
      inputTokens: null,
      totalCostUsd: null,
      error: (err as Error).message,
    };
  }
}

async function main(): Promise<void> {
  const results: Result[] = [];
  for (const m of MATRIX) {
    console.log(`probing: ${m.label}...`);
    const r = await runOne(m.args, m.label);
    console.log(`  cache_creation=${r.cacheCreation}  cost=$${r.totalCostUsd?.toFixed(4) ?? "?"}`);
    results.push(r);
  }
  const out = "system-prompt-anatomy-results.json";
  await writeFile(out, JSON.stringify(results, null, 2));
  console.log(`\nWrote ${results.length} results to ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
