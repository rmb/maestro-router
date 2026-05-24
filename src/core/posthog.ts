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
