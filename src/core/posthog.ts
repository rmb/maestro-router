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

// ── Query (read-back for tune --posthog) ──────────────────────────────────────

export type PostHogOverrideEvent = {
  ts: string;
  toClass: Class;
  hint: string;
  prompt: string;
};

export type PostHogQueryOptions = {
  queryKey: string;
  projectId: string;
  fetch?: typeof globalThis.fetch;
  host?: string;
};

export type PostHogQueryClient = {
  fetchOverrides(opts: { since: Date; limit?: number }): Promise<PostHogOverrideEvent[]>;
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

      const data = (await res.json()) as {
        results: { properties: Record<string, unknown>; timestamp: string }[];
        next: string | null;
      };

      return data.results
        .map((r) => ({
          ts: r.timestamp,
          toClass: (r.properties["to_class"] as Class) ?? "standard",
          hint: (r.properties["hint"] as string) ?? "",
          prompt: (r.properties["prompt"] as string) ?? "",
        }))
        .filter((e) => e.prompt.length > 0);
    },
  };
}
