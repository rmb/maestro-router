# Inspiration

Maestro builds on patterns from several prior projects. None of these are
runtime dependencies; their design ideas informed Maestro's architecture.

## Microsoft Chat Customizations Evaluations

Source of:
- Anti-injection wrapping pattern (`<PROMPT_TO_CLASSIFY>...</PROMPT_TO_CLASSIFY>`)
  — when an LLM classifies user-provided text, wrapping it in unambiguous tags
  prevents the classified content from being interpreted as instructions to
  the classifier. Maestro's planned v0.3 LLM classifier will use this pattern.
- `extractJSON` utility — fenced regex + brace-balanced fallback for parsing
  model output that isn't strictly JSON. Maestro's `core/extract.ts` adopts
  this approach.
- Parallel pipeline architecture with `Promise.allSettled` and weighted vote.
- Size limits on classifier inputs (truncate to 2000 chars to bound the
  classifier prompt).
- Diagnostic output convention (severity + code + message).

## musistudio/claude-code-router

Maestro does not interoperate with CCR at runtime. The CCR scenario protocol
(`background` / `think` / `longContext` / `webSearch` / `image`) influenced
the design of Maestro's turn-type classifier — both ask the same fundamental
question: "what kind of turn is this, and does it need a different
treatment?"

## RTK (Rust Token Killer)

Maestro is complementary to RTK, not a replacement. RTK operates at the
tool-output layer — intercepting `git status`, `ls`, etc. via Claude Code
hooks to compress verbose output before it consumes context tokens. Maestro
operates at the model-selection layer — choosing which model + thinking
budget handles each prompt.

Users can run both together. RTK reduces input tokens by compressing tool
outputs; Maestro reduces total cost by picking cheaper models when
appropriate.

## PostHog

PostHog's product analytics SDK pattern (event batching, hashed user IDs,
consent flows) informed Maestro's planned v0.3 remote telemetry. v0.2 ships
local-only telemetry.

## Acknowledgments

The Claude Code CLI itself (Anthropic) is the substrate everything else
plugs into. Maestro is a thin layer; the heavy lifting happens in Claude
Code and the Claude API.
