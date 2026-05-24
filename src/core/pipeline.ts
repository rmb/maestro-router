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
          return decision;
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
        return decision;
      }

      const decision = buildDecision({
        cls: DEFAULT_CLASS,
        classifier: "default",
        confidence: 0,
        profile,
        latencyMs: Date.now() - start,
        diagnostics: [
          ...diagnostics,
          {
            severity: "info",
            code: "fallback.default",
            message: "no classifier returned a signal",
          },
        ],
      });
      if (cache) cache.set(key, decision);
      return decision;
    },
  };
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
  const ENTROPY_ESCALATION_THRESHOLD = 0.7;

  const votes = new Map<Class, number>();
  let totalWeight = 0;
  for (const { weight, result } of args.collected) {
    const score = weight * result.confidence;
    votes.set(result.class, (votes.get(result.class) ?? 0) + score);
    totalWeight += score;
  }

  // Shannon entropy of the normalized vote distribution.
  // H=0 → unanimous; H≈log2(N) → max disagreement.
  const entropy =
    totalWeight > 0
      ? -Array.from(votes.values()).reduce((sum, score) => {
          const p = score / totalWeight;
          return p > 0 ? sum + p * Math.log2(p) : sum;
        }, 0)
      : 0;

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

  const escalate = entropy > ENTROPY_ESCALATION_THRESHOLD;
  const finalClass = escalate ? UPGRADE[winningClass] : winningClass;
  const finalDiagnostics: Diagnostic[] = escalate
    ? [
        ...args.diagnostics,
        {
          severity: "info" as const,
          code: "pipeline.entropy_escalation",
          message: `${winningClass} → ${finalClass} (vote entropy ${entropy.toFixed(2)} > ${ENTROPY_ESCALATION_THRESHOLD})`,
        },
      ]
    : [...args.diagnostics];

  return buildDecision({
    cls: finalClass,
    classifier: topContributor ? `vote:${topContributor.name}` : "vote",
    confidence: winningScore,
    profile: args.profile,
    latencyMs: args.latencyMs,
    diagnostics: finalDiagnostics,
  });
}
