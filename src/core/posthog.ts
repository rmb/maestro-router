// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import type { Class } from "./types.js";

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
 * Pass an empty apiKey to produce a no-op client.
 */
export function createPostHogClient(apiKey: string, opts: PostHogClientOptions = {}): PostHogClient {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;

  return {
    async capture(event: string, properties: Record<string, unknown>): Promise<void> {
      if (!apiKey) return;
      try {
        // distinct_id must be top-level on the batch item for PostHog person association.
        const { distinct_id, ...rest } = properties;
        await fetchFn(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            batch: [{ event, distinct_id: distinct_id ?? "maestro-unknown", properties: rest, timestamp: new Date().toISOString() }],
          }),
        });
      } catch {
        // fire-and-forget: routing must never block on telemetry
      }
    },
  };
}

// ── Query (read-back for tune --posthog) ──────────────────────────────────────

export type PostHogOverrideEvent = {
  ts: string;
  toClass: Class;
  hint: string;
  prompt: string;
};

export type PostHogCorrectionEvent = {
  ts: string;
  prevClass: Class;
  correctedToClass: Class;
  hint: string;
  prevPrompt: string;
};

export type PostHogQueryOptions = {
  queryKey: string;
  projectId: string;
  fetch?: typeof globalThis.fetch;
  host?: string;
};

export type PostHogQueryClient = {
  fetchOverrides(opts: { since: Date; limit?: number }): Promise<PostHogOverrideEvent[]>;
  /** Fetch maestro_correction events — implicit mis-classification signals from next-turn overrides. */
  fetchCorrections(opts: { since: Date; limit?: number }): Promise<PostHogCorrectionEvent[]>;
};

const DEFAULT_HOST = "https://app.posthog.com";

export function createPostHogQueryClient(opts: PostHogQueryOptions): PostHogQueryClient {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const host = opts.host ?? DEFAULT_HOST;

  return {
    async fetchOverrides({ since, limit = 1000 }: { since: Date; limit?: number }): Promise<PostHogOverrideEvent[]> {
      // Uses HogQL query endpoint — compatible with "Query → Read" personal API key scope.
      const url = `${host}/api/projects/${opts.projectId}/query/`;
      const query =
        `SELECT timestamp, properties.to_class, properties.hint, properties.prompt ` +
        `FROM events ` +
        `WHERE event = 'maestro_override' AND timestamp > '${since.toISOString()}' ` +
        `ORDER BY timestamp DESC ` +
        `LIMIT ${limit}`;

      const res = await fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.queryKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
      });

      if (!res.ok) {
        if (res.status === 403) {
          throw new Error(
            `PostHog query failed: 403 Forbidden\n` +
              `  • posthogQueryKey must be a Personal API Key (starts with phx_), not a Project API Key (phc_)\n` +
              `  • Personal API Key needs "Query → Read" scope (PostHog → Settings → Personal API Keys)\n` +
              `  • posthogProjectId must be the numeric project ID (PostHog → Project Settings → Project ID)`,
          );
        }
        throw new Error(`PostHog query failed: ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as {
        results: [string, string, string, string][];
      };

      return (data.results ?? [])
        .map(([ts, toClass, hint, prompt]) => ({
          ts,
          toClass: (toClass as Class) ?? "standard",
          hint: hint ?? "",
          prompt: prompt ?? "",
        }))
        .filter((e) => e.prompt.length > 0);
    },

    async fetchCorrections({ since, limit = 1000 }: { since: Date; limit?: number }): Promise<PostHogCorrectionEvent[]> {
      const url = `${host}/api/projects/${opts.projectId}/query/`;
      const query =
        `SELECT timestamp, properties.prev_class, properties.corrected_to_class, properties.hint, properties.prev_prompt ` +
        `FROM events ` +
        `WHERE event = 'maestro_correction' AND timestamp > '${since.toISOString()}' ` +
        `ORDER BY timestamp DESC ` +
        `LIMIT ${limit}`;

      const res = await fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.queryKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
      });

      if (!res.ok) {
        if (res.status === 403) {
          throw new Error(
            `PostHog query failed: 403 Forbidden\n` +
              `  • posthogQueryKey must be a Personal API Key (starts with phx_), not a Project API Key (phc_)\n` +
              `  • Personal API Key needs "Query → Read" scope (PostHog → Settings → Personal API Keys)\n` +
              `  • posthogProjectId must be the numeric project ID (PostHog → Project Settings → Project ID)`,
          );
        }
        throw new Error(`PostHog query failed: ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as {
        results: [string, string, string, string, string][];
      };

      return (data.results ?? [])
        .map(([ts, prevClass, correctedToClass, hint, prevPrompt]) => ({
          ts,
          prevClass: (prevClass as Class) ?? "standard",
          correctedToClass: (correctedToClass as Class) ?? "standard",
          hint: hint ?? "",
          prevPrompt: prevPrompt ?? "",
        }))
        .filter((e) => e.prevPrompt.length > 0);
    },
  };
}
