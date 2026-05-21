// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
// budget: 50ms p95

import type { Cache } from "./cache.js";
import { cacheKey } from "./cache.js";
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

const SHORT_CIRCUIT_THRESHOLD = 0.6;
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
          const decision = buildDecision({
            cls: result.class,
            classifier: c.name,
            confidence: result.confidence,
            profile,
            latencyMs: Date.now() - start,
            diagnostics,
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
