// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Command } from "commander";
import { bold, cyan, dim, gray, green, header, magenta, yellow } from "./render.js";

type GuideItem = {
  cmd?: string;
  text: string;
  hint?: string;
};

type GuideSection = {
  title: string;
  subtitle: string;
  items: ReadonlyArray<GuideItem>;
};

const SECTIONS: ReadonlyArray<GuideSection> = [
  {
    title: "Now",
    subtitle: "one-time setup, ~2 minutes",
    items: [
      {
        text: "Reload VSCode",
        hint: "Cmd+Shift+P → Developer: Reload Window",
      },
      {
        text: "Send any prompt in the Claude Code panel",
        hint: "Maestro classifies it and picks the cheapest model that works",
      },
      {
        cmd: "maestro stats",
        text: "Confirm the first decision was logged",
      },
      {
        cmd: "maestro install-hook",
        text: "Optional: enable feedback prompts (1-5 rating after each response)",
        hint: "occasional sampling — not annoying",
      },
    ],
  },
  {
    title: "This week",
    subtitle: "after ~20-50 real prompts, ~5 minutes",
    items: [
      {
        cmd: "maestro stats",
        text: "See realized savings vs Opus-everywhere baseline",
      },
      {
        cmd: "maestro stats --since 14",
        text: "Wider window if savings look noisy",
      },
      {
        cmd: "maestro telemetry show --limit 20",
        text: "Audit the last 20 decisions and their costs",
      },
      {
        cmd: "maestro tune",
        text: "See patterns you keep overriding manually",
        hint: "if you've used @deep or @fast more than 5 times on similar prompts, tune surfaces it",
      },
    ],
  },
  {
    title: "Ongoing",
    subtitle: "every couple weeks, ~10 minutes",
    items: [
      {
        cmd: "maestro tune --apply",
        text: "Bake the learned override patterns into ~/.maestro/heuristics.json",
        hint: "reversible — edit the file directly to undo",
      },
      {
        cmd: "maestro bench",
        text: "Regression check vs the eval baseline (free, fast)",
      },
      {
        cmd: "maestro bench --propose ~/.maestro/profile-overrides.json",
        text: "Validate any proposed change against the eval baseline",
      },
      {
        cmd: "maestro stats --since 30",
        text: "Monthly cost summary",
      },
    ],
  },
  {
    title: "One-time deep tune",
    subtitle: "when you have budget for ~$5, finds durable wins",
    items: [
      {
        cmd: "maestro bench --tournament",
        text: "Preview cost (no spend)",
      },
      {
        cmd: "maestro bench --tournament --confirm-cost --tournament-output ~/proposed.json",
        text: "Run the tournament with judge",
        hint: "spawns A (current tier) + B (one cheaper) + Sonnet judge per prompt; ~$1.50 default sample",
      },
      {
        cmd: "maestro bench --propose ~/proposed.json",
        text: "Gate the tournament's proposal against the eval baseline",
      },
    ],
  },
];

export function registerGuideCommand(program: Command): void {
  program
    .command("guide")
    .description("Show the post-install checklist: what to run now, this week, ongoing")
    .option("--plain", "no ANSI styling (for piping or non-TTY consumers)")
    .action(() => {
      process.stdout.write(render(SECTIONS) + "\n");
    });
}

function render(sections: ReadonlyArray<GuideSection>): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `${green("✓")} ${bold("Maestro is installed")} ${dim("— here's what to run when:")}`,
  );

  for (const section of sections) {
    lines.push("");
    lines.push(header(section.title));
    lines.push(dim(`  ${section.subtitle}`));
    lines.push("");
    for (const item of section.items) {
      if (item.cmd) {
        lines.push(`  ${magenta("$")} ${cyan(item.cmd)}`);
        lines.push(`      ${gray(item.text)}`);
      } else {
        lines.push(`  ${yellow("•")} ${item.text}`);
      }
      if (item.hint) {
        lines.push(`      ${dim(item.hint)}`);
      }
    }
  }

  lines.push("");
  lines.push(
    dim(`  Run ${cyan("maestro guide")} ${dim("any time to see this again.")}`),
  );
  lines.push(
    dim(`  Full command reference: ${cyan("maestro --help")} ${dim("· architecture: docs/ARCHITECTURE.md")}`),
  );
  return lines.join("\n");
}
