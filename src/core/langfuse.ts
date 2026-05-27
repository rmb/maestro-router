// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { TelemetryEvent } from "./types.js";

export type LangfuseClient = {
  /** Fire-and-forget — never throws. */
  flush(event: TelemetryEvent): void;
};

type LangfuseClientOptions = {
  publicKey: string;
  secretKey: string;
  host?: string;
  /**
   * Override the Langfuse constructor — used in tests to inject a fake
   * without needing to mock ESM dynamic imports. Pass `null` to simulate
   * the peer-not-installed path (triggers the stderr warning).
   */
  _ctor?: LangfuseCtor | null;
};

/**
 * Shape we need from the `langfuse` peer. Declared loosely so we can import
 * it dynamically without requiring its types in devDependencies.
 */
type LangfuseTraceArgs = {
  name: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
};

type LangfuseInstance = {
  trace(args: LangfuseTraceArgs): unknown;
};

type LangfuseCtor = new (opts: {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
}) => LangfuseInstance;

// Module-level sentinel so we only log the "peer missing" warning once.
let _peerMissingWarned = false;

/**
 * Try to lazily import the `langfuse` optional peer. Returns null if it is not
 * installed. The promise is cached so the import happens at most once per process.
 */
let _langfuseImport: Promise<{ Langfuse: LangfuseCtor } | null> | null = null;

async function getLangfuseCtor(): Promise<LangfuseCtor | null> {
  if (!_langfuseImport) {
    _langfuseImport = (async () => {
      try {
        const moduleName = "langfuse";
        const mod = (await import(/* @vite-ignore */ moduleName)) as {
          Langfuse: LangfuseCtor;
        };
        return mod;
      } catch {
        return null;
      }
    })();
  }
  const mod = await _langfuseImport;
  return mod?.Langfuse ?? null;
}

/** Reset module-level state; tests only. */
export function __resetLangfuseCachesForTest(): void {
  _langfuseImport = null;
  _peerMissingWarned = false;
}

/**
 * Create a Langfuse client that streams Maestro telemetry events to a Langfuse
 * project. The `langfuse` peer must be installed; if it's missing, all calls
 * silently no-op after a one-time stderr warning.
 *
 * All methods are fire-and-forget and never throw.
 */
export function createLangfuseClient(opts: LangfuseClientOptions): LangfuseClient {
  // Lazily create the Langfuse instance — we only create it once keys are configured.
  let instancePromise: Promise<LangfuseInstance | null> | null = null;

  const getInstance = (): Promise<LangfuseInstance | null> => {
    if (!instancePromise) {
      instancePromise = (async () => {
        // Use injected constructor (tests) or dynamically imported peer (production).
        // When _ctor is explicitly provided (even null), skip the dynamic import.
        // `null` simulates the peer-not-installed path.
        const usedInjected = "_ctor" in opts;
        const Ctor: LangfuseCtor | null = usedInjected
          ? (opts._ctor ?? null)
          : await getLangfuseCtor();
        if (Ctor === null) {
          if (!_peerMissingWarned) {
            _peerMissingWarned = true;
            process.stderr.write(
              "[maestro] langfuse peer not installed — Langfuse integration disabled. " +
                "Install it with: npm install -g langfuse\n",
            );
          }
          return null;
        }
        try {
          return new Ctor({
            publicKey: opts.publicKey,
            secretKey: opts.secretKey,
            ...(opts.host ? { baseUrl: opts.host } : {}),
          });
        } catch (err) {
          process.stderr.write(
            `[maestro] Langfuse client init failed: ${(err as Error).message}\n`,
          );
          return null;
        }
      })();
    }
    return instancePromise;
  };

  return {
    flush(event: TelemetryEvent): void {
      // Fire-and-forget; never throws.
      void (async () => {
        try {
          const instance = await getInstance();
          if (instance === null) return;

          if (event.type === "decision") {
            instance.trace({
              name: "maestro-decision",
              input: event.prompt,
              metadata: {
                class: event.decision.class,
                classifier: event.decision.classifier,
                confidence: event.decision.confidence,
                model: event.decision.spec.model,
                effort: event.decision.spec.effort,
                sessionId: event.sessionId,
              },
            });
          } else if (event.type === "outcome") {
            instance.trace({
              name: "maestro-outcome",
              output: {
                stopReason: event.stopReason,
                outputTokens: event.outputTokens,
                totalCostUsd: event.totalCostUsd,
              },
              metadata: {
                sessionId: event.sessionId,
                decidedClass: event.decidedClass,
              },
            });
          } else if (event.type === "correction") {
            instance.trace({
              name: "maestro-correction",
              metadata: {
                prevClass: event.prevClass,
                correctedToClass: event.correctedToClass,
                sessionId: event.sessionId,
                hint: event.hint,
              },
            });
          }
          // Other event types (feedback, compact, override) are not forwarded.
        } catch {
          // Swallow all errors — Langfuse must never affect the hot path.
        }
      })();
    },
  };
}
