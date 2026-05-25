// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
// budget: 50ms p95

import type { Cache } from "./cache.js";
import { cacheKey } from "./cache.js";
import { UPGRADE } from "./profile.js";
import type {
  Class,
  Classification,
  Classifier,
  ClassifyOptions,
  Decision,
  Diagnostic,
  Profile,
  Request,
} from "./types.js";

const SHORT_CIRCUIT_THRESHOLD = 0.55;
/**
 * Confidence above which the classifier's predicted class is trusted as-is.
 * Between SHORT_CIRCUIT and HIGH thresholds, the class is upgraded one tier
 * via UPGRADE — the misroute-up penalty (~$0.05) is bounded; misroute-down
 * (Haiku-on-Opus-task) costs ~$0.50, so we bias upward on uncertainty.
 */
const HIGH_CONFIDENCE_THRESHOLD = 0.85;
const DEFAULT_CLASS: Class = "standard";

export type PipelineOptions = {
  classifiers: ReadonlyArray<Classifier>;
  profile: Profile;
  cache?: Cache<Decision>;
};

export type Pipeline = {
  route(req: Request, opts?: ClassifyOptions): Promise<Decision>;
};

/**
 * Check if markov lock-in should be broken. Returns true when the prompt
 * shows signals of a complexity shift that should force full re-evaluation.
 */
function shouldBreakMarkovLock(prompt: string, sessionRecentAvgLength?: number): boolean {
  // Prompt is much longer than session average — signals scope shift
  if (sessionRecentAvgLength !== undefined && prompt.length > sessionRecentAvgLength * 2.5) return true;
  // Hard escalation keywords
  if (/\b(bug|race|deadlock|crash|fail|broken|error|prod|incident|outage|regression)\b/i.test(prompt)) return true;
  // Override hint present — user is manually routing
  if (/^@(fast|think|deep|slow)\b/i.test(prompt.trim())) return true;
  return false;
}

/**
 * Build a pipeline that iterates classifiers in declared order. The cheap-first
 * ordering invariant (C2) is the caller's responsibility — the pipeline executes
 * exactly the order it receives. Sub-threshold results from each classifier are
 * collected into a weighted vote at the end if no short-circuit fires.
 */
export function createPipeline(opts: PipelineOptions): Pipeline {
  const { classifiers, profile, cache } = opts;

  return {
    async route(req: Request, classifyOpts?: ClassifyOptions): Promise<Decision> {
      const start = Date.now();
      const key = cacheKey(req.prompt, req.scenarioHint);

      if (cache) {
        const cached = cache.get(key);
        if (cached) {
          return {
            ...cached,
            latencyMs: 0,
            cacheHit: true,
            diagnostics: [
              ...cached.diagnostics,
              { severity: "info", code: "cache.hit", message: "served from cache" },
            ],
          };
        }
      }

      const diagnostics: Diagnostic[] = [];
      const collected: Array<{ name: string; weight: number; result: Classification }> = [];

      for (const c of classifiers) {
        let result: Classification | null;
        try {
          result = await c.classify(req, classifyOpts);
        } catch (err) {
          diagnostics.push({
            severity: "warning",
            code: `error.${c.name}`,
            message: (err as Error).message ?? String(err),
          });
          continue;
        }
        if (result === null) continue;
        if (result.diagnostics) diagnostics.push(...result.diagnostics);
        if (result.confidence >= SHORT_CIRCUIT_THRESHOLD) {
          // Asymmetric upgrade only kicks in for classifiers whose
          // confidence is meaningfully calibrated to misroute-risk — in
          // practice that's the LLM stage, whose system prompt explicitly
          // teaches it to express uncertainty. Heuristic/embedding
          // confidences encode boundary strength, not reliability;
          // upgrading them would shift many correctly-routed prompts up a
          // tier (verified empirically — caused a 40pp accuracy regression
          // when applied globally).
          const upgrade =
            c.name === "llm" && result.confidence < HIGH_CONFIDENCE_THRESHOLD;
          const finalClass = upgrade ? UPGRADE[result.class] : result.class;
          const finalDiagnostics: Diagnostic[] = upgrade
            ? [
                ...diagnostics,
                {
                  severity: "info",
                  code: "pipeline.upgrade",
                  message: `${result.class} → ${finalClass} (conf ${result.confidence.toFixed(2)} < ${HIGH_CONFIDENCE_THRESHOLD})`,
                },
              ]
            : [...diagnostics];
          const decision = buildDecision({
            cls: finalClass,
            classifier: c.name,
            confidence: result.confidence,
            profile,
            latencyMs: Date.now() - start,
            diagnostics: finalDiagnostics,
          });
          if (cache) cache.set(key, decision);
          return applyE3Escalation(decision, classifyOpts);
        }
        collected.push({ name: c.name, weight: c.weight, result });
      }

      if (collected.length > 0) {
        const decision = voteDecision({
          collected,
          profile,
          latencyMs: Date.now() - start,
          diagnostics,
        });
        if (cache) cache.set(key, decision);
        return applyE3Escalation(decision, classifyOpts);
      }

      // Y.guarantee: "forced.standard" — explicit label distinguishes this from a true
      // classification. Confidence 0.1 (not 0) signals "we had no data" without being
      // indistinguishable from an error. K2: break markov lock-in when prompt signals
      // complexity shift, even here in the all-null fallback path.
      const breakMarkov = shouldBreakMarkovLock(
        req.prompt,
        classifyOpts?.sessionContext?.recentAvgPromptLength,
      );
      const fallbackDiagCode = breakMarkov
        ? "fallback.forced_standard.markov_break"
        : "fallback.forced_standard";
      const fallbackDiagMessage = breakMarkov
        ? "markov lock-in broken — complexity shift detected; forced standard"
        : "no classifier returned a signal; forced standard";

      const decision = buildDecision({
        cls: DEFAULT_CLASS,
        classifier: "forced.standard",
        confidence: 0.1,
        profile,
        latencyMs: Date.now() - start,
        diagnostics: [
          ...diagnostics,
          {
            severity: "info",
            code: fallbackDiagCode,
            message: fallbackDiagMessage,
          },
        ],
      });
      if (cache) cache.set(key, decision);
      return applyE3Escalation(decision, classifyOpts);
    },
  };
}

/**
 * E3: reasoning class signal escalation — upgrade effort when session signals complexity.
 * Applied post-decision, before return. Only acts on class === "reasoning".
 */
function applyE3Escalation(decision: Decision, classifyOpts?: ClassifyOptions): Decision {
  if (decision.class !== "reasoning" || !classifyOpts?.sessionContext) return decision;

  const ctx = classifyOpts.sessionContext;
  let escalationSignals = 0;

  // Signal 1: entropy was high (already escalated via pipeline.entropy_escalation diag)
  if (decision.diagnostics.some((d) => d.code === "pipeline.entropy_escalation")) escalationSignals++;
  // Signal 2: markov shows sustained hard/reasoning mode
  const last5 = ctx.recentClasses?.slice(-5) ?? [];
  if (last5.filter((c) => c === "reasoning" || c === "max").length >= 3) escalationSignals++;
  // Signal 3: prior session stop was max_tokens (passed in sessionContext)
  if (ctx.lastStopReason === "max_tokens") escalationSignals++;

  // Need 2+ signals to escalate (AND-of-2 logic). A single signal at strength 0.9+ also escalates.
  if (escalationSignals >= 2 || (escalationSignals === 1 && decision.confidence >= 0.9)) {
    const escalatedSpec = { ...decision.spec, effort: "high" as const };
    return {
      ...decision,
      spec: escalatedSpec,
      diagnostics: [
        ...decision.diagnostics,
        {
          severity: "info" as const,
          code: "pipeline.effort_escalation",
          message: `reasoning effort → high (${escalationSignals} escalation signals)`,
        },
      ],
    };
  }

  return decision;
}

function buildDecision(args: {
  cls: Class;
  classifier: string;
  confidence: number;
  profile: Profile;
  latencyMs: number;
  diagnostics: ReadonlyArray<Diagnostic>;
}): Decision {
  return {
    class: args.cls,
    classifier: args.classifier,
    confidence: args.confidence,
    spec: args.profile.classes[args.cls],
    latencyMs: args.latencyMs,
    diagnostics: args.diagnostics,
  };
}

function voteDecision(args: {
  collected: ReadonlyArray<{ name: string; weight: number; result: Classification }>;
  profile: Profile;
  latencyMs: number;
  diagnostics: ReadonlyArray<Diagnostic>;
}): Decision {
  const votes = new Map<Class, number>();
  for (const { weight, result } of args.collected) {
    votes.set(result.class, (votes.get(result.class) ?? 0) + weight * result.confidence);
  }
  let winningClass: Class = DEFAULT_CLASS;
  let winningScore = 0;
  for (const [cls, score] of votes) {
    if (score > winningScore) {
      winningClass = cls;
      winningScore = score;
    }
  }
  const topContributor = args.collected
    .filter((r) => r.result.class === winningClass)
    .sort((a, b) => b.weight * b.result.confidence - a.weight * a.result.confidence)[0];
  return buildDecision({
    cls: winningClass,
    classifier: topContributor ? `vote:${topContributor.name}` : "vote",
    confidence: winningScore,
    profile: args.profile,
    latencyMs: args.latencyMs,
    diagnostics: args.diagnostics,
  });
}
