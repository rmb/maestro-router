// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// `maestro init` — idempotent setup wizard.
// Orchestrates the four install steps in sequence and prints a per-step summary.
// budget: 200ms (dominated by filesystem writes; all IO is sequential by design
// so the summary reflects actual ordered progress)

import type { Command } from "commander";
import { spawnSync } from "node:child_process";
import { bold, cyan, dim, green, header, red } from "./render.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StepStatus = "written" | "already-present" | "failed";

export type StepResult = {
  name: string;
  status: StepStatus;
  detail?: string;
  error?: string;
};

export type InitResult = {
  ok: boolean;
  steps: StepResult[];
};

export type InstallStepOutcome = {
  status: "written" | "already-present";
};

export type InitDependencies = {
  installDefaults: () => Promise<InstallStepOutcome>;
  installVscode: () => Promise<InstallStepOutcome>;
  installCommands: () => Promise<InstallStepOutcome>;
  installHook: () => Promise<InstallStepOutcome>;
};

// ---------------------------------------------------------------------------
// Core logic (pure, injectable)
// ---------------------------------------------------------------------------

async function runStep(
  name: string,
  fn: () => Promise<InstallStepOutcome>,
): Promise<StepResult> {
  try {
    const outcome = await fn();
    return { name, status: outcome.status };
  } catch (err) {
    return {
      name,
      status: "failed",
      error: (err as Error).message ?? String(err),
    };
  }
}

export async function runInit(deps: InitDependencies): Promise<InitResult> {
  const steps: StepResult[] = [
    await runStep("defaults", deps.installDefaults),
    await runStep("vscode", deps.installVscode),
    await runStep("commands", deps.installCommands),
    await runStep("hook", deps.installHook),
  ];
  return { ok: steps.every((s) => s.status !== "failed"), steps };
}

// ---------------------------------------------------------------------------
// Default install step adapters (wrap existing CLI command logic)
// ---------------------------------------------------------------------------

/**
 * Each adapter calls the corresponding `maestro install-*` subcommand via
 * spawnSync so we reuse the exact same logic as the standalone commands
 * without importing their internals. This avoids re-implementing idempotency
 * checks and means future changes to each installer are automatically
 * reflected in `maestro init`.
 *
 * Output is captured and discarded — `maestro init` prints its own summary.
 * A non-zero exit code causes the step to be marked "failed".
 */
function makeSpawnAdapter(
  subcommand: string,
  maestroBin: string,
): () => Promise<InstallStepOutcome> {
  return async () => {
    const res = spawnSync(maestroBin, [subcommand], {
      encoding: "utf8",
      // Capture both to suppress noise; we'll report pass/fail ourselves.
      stdio: "pipe",
    });
    if (res.status !== 0) {
      throw new Error(
        (res.stderr ?? "").trim() || `${subcommand} exited with code ${res.status ?? "?"}`,
      );
    }
    // Heuristic: if output contains "already" or "No change", it was a no-op.
    const combined = ((res.stdout ?? "") + (res.stderr ?? "")).toLowerCase();
    const alreadyPresent = combined.includes("already") || combined.includes("no change");
    return { status: alreadyPresent ? "already-present" : "written" };
  };
}

function detectMaestroBinary(): string {
  if (process.argv[1]) return process.argv[1];
  return "maestro";
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatSummary(result: InitResult): string {
  const lines: string[] = ["", header("maestro init"), ""];
  for (const step of result.steps) {
    if (step.status === "written") {
      lines.push(`  ${green("✓ done")}           ${bold(step.name)}`);
    } else if (step.status === "already-present") {
      lines.push(`  ${dim("· already present")} ${dim(step.name)}`);
    } else {
      lines.push(
        `  ${red("✗ failed")}         ${bold(step.name)}: ${step.error ?? "unknown error"}`,
      );
    }
  }
  lines.push("");
  if (result.ok) {
    lines.push(
      `  ${green("Maestro is ready.")} Run ${cyan("maestro doctor")} to verify your environment.`,
    );
  } else {
    const failedNames = result.steps.filter((s) => s.status === "failed").map((s) => s.name);
    lines.push(
      `  ${red("Some steps failed:")} ${failedNames.join(", ")}. Run ${cyan("maestro doctor")} for details.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description(
      "Idempotent setup wizard: run all Maestro install steps in sequence and print a per-step summary.",
    )
    .action(async () => {
      const bin = detectMaestroBinary();
      const deps: InitDependencies = {
        installDefaults: makeSpawnAdapter("install-defaults", bin),
        installVscode: makeSpawnAdapter("install-vscode", bin),
        installCommands: makeSpawnAdapter("install-commands", bin),
        installHook: makeSpawnAdapter("install-hook", bin),
      };
      const result = await runInit(deps);
      process.stdout.write(formatSummary(result));
      process.exit(result.ok ? 0 : 1);
    });
}
