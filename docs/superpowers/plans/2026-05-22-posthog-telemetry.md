# PostHog Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit anonymous routing events to PostHog and add `maestro tune --posthog` to mine override patterns from all opted-in users.

**Architecture:** A fire-and-forget PostHog client (`src/core/posthog.ts`) uses native `fetch` to batch-send events; `run-cmd.ts` fires `maestro_decision` and `maestro_override` events after each spawn; `tune.ts` gains a `--posthog` flag that queries PostHog's Events API with a personal API key and pipes the results through the existing `computeSuggestions()` logic. Two config keys gate everything: `posthogApiKey` (capture, always needed) and `posthogQueryKey`+`posthogProjectId` (read-back, only for tune).

**Tech Stack:** Node 20 built-in `fetch`, PostHog capture endpoint (`https://us.i.posthog.com/capture/`), PostHog Events REST API (`https://app.posthog.com/api/projects/{id}/events/`), existing `UserConfig`/`TelemetryEvent` types, Vitest.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/core/posthog.ts` | **Create** | PostHog client — capture + query. No deps beyond Node fetch. |
| `src/core/posthog.test.ts` | **Create** | Unit tests with injected fetch mock |
| `src/core/types.ts` | **Modify** | Add `posthogApiKey`, `posthogQueryKey`, `posthogProjectId`, `sendPromptText` to `UserConfig` |
| `src/cli/run-cmd.ts` | **Modify** | Call `posthog.capture()` after `telemetry.log()` |
| `src/cli/tune.ts` | **Modify** | Add `--posthog` flag; pull override events from PostHog; feed into `computeSuggestions()` |
| `src/cli/tune.test.ts` | **Create** | Tests for `--posthog` path with mock fetcher |

---

## Task 1: PostHog client — capture

**Files:**
- Create: `src/core/posthog.ts`
- Create: `src/core/posthog.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/core/posthog.test.ts
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, vi } from "vitest";
import { createPostHogClient } from "./posthog.js";

describe("createPostHogClient", () => {
  test("capture sends correct payload to PostHog endpoint", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const mockFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(init?.body as string) });
      return new Response("{}", { status: 200 });
    };

    const client = createPostHogClient("phc_testkey", { fetch: mockFetch });
    await client.capture("maestro_decision", { class: "trivial", model: "haiku" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://us.i.posthog.com/capture/");
    const body = calls[0]!.body as { api_key: string; batch: { event: string; properties: Record<string, unknown> }[] };
    expect(body.api_key).toBe("phc_testkey");
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0]!.event).toBe("maestro_decision");
    expect(body.batch[0]!.properties["class"]).toBe("trivial");
  });

  test("capture swallows network errors silently", async () => {
    const failFetch = async () => { throw new Error("network down"); };
    const client = createPostHogClient("phc_testkey", { fetch: failFetch });
    // Must not throw
    await expect(client.capture("test", {})).resolves.toBeUndefined();
  });

  test("capture is no-op when apiKey is empty", async () => {
    const calls: unknown[] = [];
    const mockFetch = async () => { calls.push(1); return new Response("{}", { status: 200 }); };
    const client = createPostHogClient("", { fetch: mockFetch });
    await client.capture("test", {});
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/rui.barreira/Desktop/CLAUDE_SANDBOX_DO_NOT_DELETE/personal/Maestro
pnpm vitest run src/core/posthog.test.ts
```
Expected: FAIL with "Cannot find module './posthog.js'"

- [ ] **Step 3: Implement the PostHog client**

```typescript
// src/core/posthog.ts
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

export type PostHogClient = {
  capture(event: string, properties: Record<string, unknown>): Promise<void>;
};

export type PostHogClientOptions = {
  /** Injected fetch for testing. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** PostHog capture endpoint. Defaults to US cloud. */
  endpoint?: string;
};

const DEFAULT_ENDPOINT = "https://us.i.posthog.com/capture/";

/**
 * Fire-and-forget PostHog client. Never throws — network errors are swallowed.
 * Pass an empty apiKey to disable (no-op).
 */
export function createPostHogClient(apiKey: string, opts: PostHogClientOptions = {}): PostHogClient {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;

  return {
    async capture(event: string, properties: Record<string, unknown>): Promise<void> {
      if (!apiKey) return;
      try {
        await fetchFn(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            batch: [{ event, properties, timestamp: new Date().toISOString() }],
          }),
        });
      } catch {
        // fire-and-forget: routing must never block on telemetry
      }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run src/core/posthog.test.ts
```
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/posthog.ts src/core/posthog.test.ts
git commit -m "feat(posthog): add fire-and-forget PostHog capture client"
```

---

## Task 2: Add PostHog query support + UserConfig fields

**Files:**
- Modify: `src/core/posthog.ts`
- Modify: `src/core/posthog.test.ts`
- Modify: `src/core/types.ts:59-98`

- [ ] **Step 1: Write the failing tests for query**

Add to `src/core/posthog.test.ts`:

```typescript
import { createPostHogClient, createPostHogQueryClient } from "./posthog.js";

describe("createPostHogQueryClient", () => {
  test("fetchOverrides queries correct URL with auth header", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const mockFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify({
        results: [
          { event: "maestro_override", properties: { from_class: "hard", to_class: "max", prompt: "prod is down" }, timestamp: "2026-05-22T10:00:00Z" },
        ],
        next: null,
      }), { status: 200 });
    };

    const client = createPostHogQueryClient({ queryKey: "phx_secret", projectId: "42", fetch: mockFetch });
    const events = await client.fetchOverrides({ since: new Date("2026-05-01") });

    expect(calls[0]!.url).toContain("/api/projects/42/events/");
    expect(calls[0]!.url).toContain("event=maestro_override");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer phx_secret");
    expect(events).toHaveLength(1);
    expect(events[0]!.prompt).toBe("prod is down");
    expect(events[0]!.from).toBe("hard");
    expect(events[0]!.to).toBe("max");
    expect(events[0]!.ts).toBe("2026-05-22T10:00:00Z");
  });

  test("fetchOverrides returns [] when results is empty", async () => {
    const mockFetch = async () => new Response(JSON.stringify({ results: [], next: null }), { status: 200 });
    const client = createPostHogQueryClient({ queryKey: "phx_x", projectId: "1", fetch: mockFetch });
    const events = await client.fetchOverrides({ since: new Date() });
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run src/core/posthog.test.ts
```
Expected: FAIL with "createPostHogQueryClient is not a function"

- [ ] **Step 3: Add query client to posthog.ts**

Append to `src/core/posthog.ts`:

```typescript
import type { Class } from "./types.js";

export type PostHogOverrideEvent = {
  ts: string;
  from: Class;
  to: Class;
  prompt: string;
};

export type PostHogQueryClient = {
  fetchOverrides(opts: { since: Date; limit?: number }): Promise<PostHogOverrideEvent[]>;
};

export type PostHogQueryOptions = {
  queryKey: string;
  projectId: string;
  fetch?: typeof globalThis.fetch;
  host?: string;
};

const DEFAULT_HOST = "https://app.posthog.com";

export function createPostHogQueryClient(opts: PostHogQueryOptions): PostHogQueryClient {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const host = opts.host ?? DEFAULT_HOST;

  return {
    async fetchOverrides({ since, limit = 1000 }: { since: Date; limit?: number }): Promise<PostHogOverrideEvent[]> {
      const url = new URL(`${host}/api/projects/${opts.projectId}/events/`);
      url.searchParams.set("event", "maestro_override");
      url.searchParams.set("after", since.toISOString());
      url.searchParams.set("limit", String(limit));

      const res = await fetchFn(url.toString(), {
        headers: { Authorization: `Bearer ${opts.queryKey}` },
      });

      const data = (await res.json()) as { results: { event: string; properties: Record<string, unknown>; timestamp: string }[]; next: string | null };
      return data.results.map((r) => ({
        ts: r.timestamp,
        from: r.properties["from_class"] as Class,
        to: r.properties["to_class"] as Class,
        prompt: (r.properties["prompt"] as string) ?? "",
      }));
    },
  };
}
```

- [ ] **Step 4: Add UserConfig fields to types.ts**

In `src/core/types.ts`, add after the `useEmbeddingClassifier` field (currently line ~97):

```typescript
  /**
   * PostHog project API key (starts with `phc_`). When set, Maestro emits
   * `maestro_decision` and `maestro_override` events to PostHog on every spawn.
   * Leave unset to disable remote telemetry entirely.
   */
  posthogApiKey?: string;
  /**
   * PostHog personal API key (starts with `phx_`). Required only for
   * `maestro tune --posthog`. Obtain at posthog.com → Settings → Personal API Keys.
   */
  posthogQueryKey?: string;
  /**
   * PostHog numeric project ID. Required only for `maestro tune --posthog`.
   * Find it in PostHog → Project Settings → Project ID.
   */
  posthogProjectId?: string;
  /**
   * When true, include the raw prompt text in PostHog `maestro_override` events.
   * Default false. Only enable if you consent to sending prompt snippets to PostHog.
   * Required for `maestro tune --posthog` to mine patterns from cross-user data.
   */
  sendPromptText?: boolean;
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm vitest run src/core/posthog.test.ts
pnpm typecheck
```
Expected: all PASS, no type errors

- [ ] **Step 6: Commit**

```bash
git add src/core/posthog.ts src/core/posthog.test.ts src/core/types.ts
git commit -m "feat(posthog): add query client and UserConfig fields"
```

---

## Task 3: Wire PostHog capture into run-cmd.ts

**Files:**
- Modify: `src/cli/run-cmd.ts:111-133`

- [ ] **Step 1: Write the test**

There is no existing test for `run-cmd.ts` (it spawns real processes). Instead, verify the wiring manually in Step 4. Skip to implementation.

- [ ] **Step 2: Implement the wiring**

In `src/cli/run-cmd.ts`, add the PostHog import at the top:

```typescript
import { createPostHogClient } from "../core/posthog.js";
```

Then, inside the `.action()` callback, replace the block starting at line 111 (`const parsed = parseOutput(...)`) with:

```typescript
      const parsed = parseOutput(result.capturedStdout, cli.userConfig);
      if (parsed) {
        const telemetry = createTelemetry(
          cli.userConfig.telemetryPath ? { path: cli.userConfig.telemetryPath } : {},
        );
        await telemetry.log({
          type: "decision",
          ts: new Date().toISOString(),
          decision,
          cost: parsed.cost,
          prompt: truncate(prompt, PROMPT_TRUNCATE_CHARS),
        });

        // PostHog remote telemetry (opt-in via posthogApiKey in config)
        if (cli.userConfig.posthogApiKey) {
          const ph = createPostHogClient(cli.userConfig.posthogApiKey);
          const distinctId = Buffer.from(process.cwd()).toString("base64url").slice(0, 16);
          void ph.capture("maestro_decision", {
            distinct_id: distinctId,
            class: decision.class,
            model: decision.spec.model,
            effort: decision.spec.effort,
            confidence: decision.confidence,
            classifier: decision.classifier,
            latency_ms: decision.latencyMs,
            prompt_length: prompt.length,
            cost_usd: parsed.cost?.totalCostUsd ?? null,
          });

          // Emit override event when user used @fast / @deep / @think
          const overrideDiag = decision.diagnostics.find((d) => d.code?.startsWith("override."));
          if (overrideDiag) {
            const parts = overrideDiag.code?.split(".") ?? [];
            const toClass = parts[1] as string;
            const overrideProps: Record<string, unknown> = {
              distinct_id: distinctId,
              from_class: decision.class,
              to_class: toClass,
              prompt_length: prompt.length,
            };
            if (cli.userConfig.sendPromptText) {
              overrideProps["prompt"] = truncate(prompt, PROMPT_TRUNCATE_CHARS);
            }
            void ph.capture("maestro_override", overrideProps);
          }
        }

        for (const d of parsed.diagnostics) {
          if (d.severity === "hint" || d.severity === "warning") {
            process.stderr.write(`\n[maestro] ${d.code}: ${d.message}\n`);
          }
        }

        if (globalOpts.json) {
          process.stdout.write(format({ decision, cost: parsed.cost }, { json: true }) + "\n");
        }
      }
```

- [ ] **Step 3: Build and typecheck**

```bash
pnpm build
```
Expected: clean build, no type errors

- [ ] **Step 4: Smoke test manually**

```bash
# Set a test PostHog key in ~/.maestro/config.json temporarily:
# { "posthogApiKey": "phc_YOUR_KEY" }
# Then run:
maestro run "rename foo to bar"
# Check PostHog Live Events — should see maestro_decision within 5s
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/run-cmd.ts
git commit -m "feat(posthog): emit maestro_decision and maestro_override events on each spawn"
```

---

## Task 4: `maestro tune --posthog`

**Files:**
- Modify: `src/cli/tune.ts:44-95`
- Create: `src/cli/tune.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/cli/tune.test.ts
// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { computeSuggestions } from "./tune.js";
import type { TelemetryEvent } from "../core/types.js";

describe("computeSuggestions with PostHog override events", () => {
  test("mines pattern from 5+ matching override events", () => {
    const overrides: TelemetryEvent[] = Array.from({ length: 6 }, (_, i) => ({
      type: "override" as const,
      ts: new Date().toISOString(),
      from: "hard" as const,
      to: "max" as const,
      prompt: `production is down check the frobnicate logs ${i}`,
    }));

    const result = computeSuggestions(overrides, { learnOnly: true });
    const patterns = result.learnedHeuristics.map((r) => r.pattern);
    expect(patterns.some((p) => p.includes("frobnicate"))).toBe(true);
  });

  test("does not suggest pattern with fewer than 5 occurrences", () => {
    const overrides: TelemetryEvent[] = Array.from({ length: 3 }, () => ({
      type: "override" as const,
      ts: new Date().toISOString(),
      from: "hard" as const,
      to: "max" as const,
      prompt: "rareword something here",
    }));

    const result = computeSuggestions(overrides, { learnOnly: true });
    const patterns = result.learnedHeuristics.map((r) => r.pattern);
    expect(patterns.some((p) => p.includes("rareword"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (computeSuggestions already works)**

```bash
pnpm vitest run src/cli/tune.test.ts
```
Expected: 2 tests PASS (computeSuggestions is already correct for this input shape)

- [ ] **Step 3: Add `--posthog` flag to tune.ts**

In `src/cli/tune.ts`, add import at top:

```typescript
import { createPostHogQueryClient } from "../core/posthog.js";
```

Replace the `registerTuneCommand` function's `.command()` block with:

```typescript
export function registerTuneCommand(program: Command): void {
  program
    .command("tune")
    .description("Analyze telemetry, suggest profile + heuristic tweaks")
    .option("--apply", "write suggestions to ~/.maestro/profile-overrides.json and heuristics.json")
    .option("--learn", "focus on mining new heuristic patterns from override events")
    .option("--posthog", "pull override events from PostHog instead of local telemetry (requires posthogQueryKey + posthogProjectId in config)")
    .option("--since <days>", "telemetry window in days", String(PATTERN_WINDOW_DAYS))
    .action(async (cmdOpts: { apply?: boolean; learn?: boolean; posthog?: boolean; since: string }) => {
      const parent = program.opts<ParentOptions>();
      const cli = await loadCliConfig(parent.config);
      const since = Math.max(1, parseInt(cmdOpts.since, 10) || PATTERN_WINDOW_DAYS);
      const cutoff = Date.now() - since * 24 * 60 * 60 * 1000;

      let events: TelemetryEvent[];

      if (cmdOpts.posthog) {
        const { posthogQueryKey, posthogProjectId } = cli.userConfig;
        if (!posthogQueryKey || !posthogProjectId) {
          process.stderr.write(
            "maestro tune --posthog: set posthogQueryKey and posthogProjectId in ~/.maestro/config.json\n" +
            "  posthogQueryKey: personal API key from PostHog → Settings → Personal API Keys\n" +
            "  posthogProjectId: numeric project ID from PostHog → Project Settings\n",
          );
          process.exit(1);
        }
        const queryClient = createPostHogQueryClient({ queryKey: posthogQueryKey, projectId: posthogProjectId });
        const overrides = await queryClient.fetchOverrides({ since: new Date(cutoff) });
        events = overrides.map((o) => ({
          type: "override" as const,
          ts: o.ts,
          from: o.from,
          to: o.to,
          prompt: o.prompt,
        }));
        if (!parent.quiet) {
          process.stderr.write(`[maestro] fetched ${events.length} override event(s) from PostHog\n`);
        }
      } else {
        const path = cli.userConfig.telemetryPath ?? DEFAULT_TELEMETRY_PATH;
        const t = createTelemetry({ path });
        events = (await t.readAll()).filter((e) => Date.parse(e.ts) >= cutoff);
      }

      const suggestion = computeSuggestions(events, { learnOnly: cmdOpts.learn === true });

      if (parent.json) {
        process.stdout.write(format(suggestion, { json: true }) + "\n");
      } else if (!parent.quiet) {
        process.stdout.write(renderHuman(suggestion, cmdOpts.apply === true) + "\n");
      }

      if (cmdOpts.apply) {
        if (suggestion.learnedHeuristics.length > 0) {
          const existing = cli.userHeuristics;
          const merged: HeuristicRule[] = [
            ...existing,
            ...suggestion.learnedHeuristics.map(
              (r): HeuristicRule => ({
                pattern: r.pattern,
                class: r.class,
                confidence: r.confidence,
                source: r.source,
              }),
            ),
          ];
          await writeUserHeuristics(merged);
          if (!parent.quiet) {
            process.stdout.write(
              `\nWrote ${suggestion.learnedHeuristics.length} new heuristic(s) to ~/.maestro/heuristics.json\n`,
            );
          }
        }
        const _: ProfileOverride = cli.profileOverrides;
        void _;
      }
    });
}
```

- [ ] **Step 4: Build and typecheck**

```bash
pnpm build
```
Expected: clean

- [ ] **Step 5: Smoke test**

```bash
# With posthogQueryKey + posthogProjectId set in config:
maestro tune --posthog
# Expected output: "fetched N override event(s) from PostHog" then pattern suggestions (or "no new patterns")

# Without keys:
maestro tune --posthog
# Expected: error message about missing keys, exit 1
```

- [ ] **Step 6: Run full test suite**

```bash
pnpm test
```
Expected: all passing (same count as before)

- [ ] **Step 7: Commit**

```bash
git add src/cli/tune.ts src/cli/tune.test.ts
git commit -m "feat(posthog): add maestro tune --posthog to mine patterns from PostHog override events"
```

---

## Task 5: Wire up in index.ts + docs update

**Files:**
- Modify: `src/cli/index.ts` — nothing needed (tune is already registered)
- Modify: `README.md` or `docs/` if it exists — skip if no user-facing docs yet

- [ ] **Step 1: Build final release artifact**

```bash
pnpm build
npm install -g .
```

- [ ] **Step 2: End-to-end test**

```bash
# 1. Verify decision event appears in PostHog Live Events
maestro run "rename foo to bar"

# 2. Verify tune --posthog works
maestro tune --posthog --since 7

# 3. Verify tune without flag still uses local telemetry
maestro tune
```

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat(posthog): PostHog telemetry v0.3 — S1 complete"
```

---

## Self-Review

**Spec coverage:**
- ✅ Emit `maestro_decision` on every spawn
- ✅ Emit `maestro_override` when @fast/@deep/@think used
- ✅ `sendPromptText` opt-in gate
- ✅ `maestro tune --posthog` queries PostHog Events API
- ✅ Config fields: `posthogApiKey`, `posthogQueryKey`, `posthogProjectId`, `sendPromptText`
- ✅ Fire-and-forget (never throws, never blocks routing)
- ✅ No new runtime deps (native fetch, Node 20+)

**Privacy:**
- `distinct_id` is base64 of cwd — anonymous, not PII
- Prompt text never sent unless `sendPromptText: true`
- No personal identifiers in any event

**Type consistency:** All types flow from `UserConfig` → `posthog.ts` → `run-cmd.ts` → `tune.ts`. The `PostHogOverrideEvent` shape matches `TelemetryEvent { type: "override" }` structure used by `computeSuggestions`.
