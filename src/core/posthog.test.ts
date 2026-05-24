// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
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
    const body = calls[0]!.body as {
      api_key: string;
      batch: { event: string; properties: Record<string, unknown> }[];
    };
    expect(body.api_key).toBe("phc_testkey");
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0]!.event).toBe("maestro_decision");
    expect(body.batch[0]!.properties["class"]).toBe("trivial");
  });

  test("capture swallows network errors silently", async () => {
    const failFetch = async (): Promise<Response> => {
      throw new Error("network down");
    };
    const client = createPostHogClient("phc_testkey", { fetch: failFetch });
    await expect(client.capture("test", {})).resolves.toBeUndefined();
  });

  test("capture is no-op when apiKey is empty", async () => {
    const calls: unknown[] = [];
    const mockFetch = async () => {
      calls.push(1);
      return new Response("{}", { status: 200 });
    };
    const client = createPostHogClient("", { fetch: mockFetch });
    await client.capture("test", {});
    expect(calls).toHaveLength(0);
  });

  test("capture includes timestamp in batch entry", async () => {
    const calls: { body: unknown }[] = [];
    const mockFetch = async (_url: string, init?: RequestInit) => {
      calls.push({ body: JSON.parse(init?.body as string) });
      return new Response("{}", { status: 200 });
    };
    const client = createPostHogClient("phc_key", { fetch: mockFetch });
    await client.capture("maestro_test", { x: 1 });
    const body = calls[0]!.body as { batch: { timestamp: string }[] };
    expect(body.batch[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
