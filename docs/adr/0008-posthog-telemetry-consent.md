# ADR-0008 · Remote telemetry via PostHog — opt-in only, no PII

## Status

Accepted · 2026-05-27

## Context

Maestro stores every routing decision in `~/.maestro/decisions.jsonl` (local JSONL).
This is useful for `maestro stats` and `maestro tune`, but it is per-machine.
Cross-user correction patterns — the signal most valuable for improving the heuristic
classifier — are invisible without an aggregation layer.

PostHog is the chosen aggregation backend (self-hostable, EU-region available,
HogQL for ad-hoc queries, free tier covers expected usage). Two distinct keys are
involved:

- **Project key (`phc_*`)** — write-only; used by the Maestro CLI to capture events.
- **Personal API key (`phx_*`)** — read-only; used by `maestro tune --posthog` to
  query correction patterns back.

The core send/query client ships in `src/core/posthog.ts` (fire-and-forget, never
throws, swallows all network errors so routing is never blocked by telemetry).

## Decision

### Opt-in gate

Remote capture is **disabled by default**. It activates only when the user explicitly
sets `posthogApiKey` in `~/.maestro/config.json`. No event is emitted before that key
is present.

There is no consent prompt, banner, or first-run wizard — the user opts in by
configuration, which is already an intentional act.

### Events emitted

| Event | When | PII risk |
|-------|------|----------|
| `maestro_decision` | Every routed turn | None — class, model, effort, confidence, classifier, prompt_length, cost_usd |
| `maestro_outcome` | After spawn completes | None — stop_reason, output_tokens, cache tokens |
| `maestro_correction` | When current turn class ≠ prev turn class | None — prev_class, corrected_to_class, hint, prev_prompt_length |

Raw prompt text is **never sent** unless the user also sets `sendPromptText: true` in
config. The default is `false`.

### Distinct ID derivation

The `distinct_id` field must not be PII. It is derived as:

```ts
// For decision/outcome events
createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16)

// For early-correction events
Buffer.from(process.cwd()).toString("base64url").slice(0, 16)
```

This produces a stable, pseudonymous identifier per working directory. It cannot be
reversed to a username, email, or machine hostname.

### Consent management subcommands

```
maestro telemetry off          # removes posthogApiKey from config; idempotent
maestro telemetry forget       # deletes decisions.jsonl + resets counters; requires --confirm
```

`telemetry off` removes only the PostHog key — local JSONL continues to be written.
`telemetry forget` deletes local history regardless of whether PostHog is enabled.
The two operations are intentionally independent.

### What is NOT sent

- Usernames, hostnames, email addresses, git remote URLs.
- Raw prompt text (unless `sendPromptText: true`).
- File contents, tool results, model responses.
- The working directory path (only a hash/truncated base64 of it).
- Any telemetry when `posthogApiKey` is absent.

## Alternatives considered

**Anonymous auto-collection on first run (opt-out)** — rejected. Maestro routes
prompts that may touch sensitive codebases. The safer default is silence; the user
must choose to share.

**Local-only aggregation forever** — viable but limits the ability to improve the
heuristic and Markov classifiers beyond a single user's history. Cross-user correction
data is the primary signal for classifier improvement.

**Segment / Amplitude / Mixpanel** — PostHog preferred for self-hostability and
HogQL (direct SQL queries useful for `tune --posthog` without a separate ETL).

## Consequences

- Cross-user correction patterns become available for `tune --posthog` when enough
  users opt in.
- Users who do not set `posthogApiKey` are unaffected; no code path changes for them.
- Fire-and-forget design means a PostHog outage or network failure never degrades
  routing latency.
- The pseudonymous distinct_id means PostHog data cannot be linked to a specific user
  without the user explicitly adding identifying properties (which Maestro does not do).
