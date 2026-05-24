// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { createPostHogClient, createPostHogQueryClient } from "./posthog.js";

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

  test("capture swallows non-ok HTTP status silently", async () => {
    const mockFetch = async () => new Response("error", { status: 400 });
    const client = createPostHogClient("phc_key", { fetch: mockFetch });
    await expect(client.capture("test", {})).resolves.toBeUndefined();
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

describe("createPostHogQueryClient", () => {
  test("fetchOverrides queries correct URL with auth header", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const mockFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers as Record<string, string> });
      return new Response(
        JSON.stringify({
          results: [
            {
              event: "maestro_override",
              properties: { from_class: "hard", to_class: "max", hint: "deep", prompt: "prod is down" },
              timestamp: "2026-05-22T10:00:00Z",
            },
          ],
          next: null,
        }),
        { status: 200 },
      );
    };

    const client = createPostHogQueryClient({ queryKey: "phx_secret", projectId: "42", fetch: mockFetch });
    const events = await client.fetchOverrides({ since: new Date("2026-05-01") });

    expect(calls[0]!.url).toContain("/api/projects/42/events/");
    expect(calls[0]!.url).toContain("event=maestro_override");
    expect(calls[0]!.url).toContain("limit=1000");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer phx_secret");
    expect(events).toHaveLength(1);
    expect(events[0]!.prompt).toBe("prod is down");
    expect(events[0]!.toClass).toBe("max");
    expect(events[0]!.ts).toBe("2026-05-22T10:00:00Z");
  });

  test("fetchOverrides returns [] when results is empty", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ results: [], next: null }), { status: 200 });
    const client = createPostHogQueryClient({ queryKey: "phx_x", projectId: "1", fetch: mockFetch });
    const events = await client.fetchOverrides({ since: new Date() });
    expect(events).toEqual([]);
  });

  test("fetchOverrides filters out events with missing prompt when sendPromptText was false", async () => {
    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            { event: "maestro_override", properties: { to_class: "max", prompt: "" }, timestamp: "2026-01-01T00:00:00Z" },
            { event: "maestro_override", properties: { to_class: "hard", prompt: "real prompt here" }, timestamp: "2026-01-01T00:00:00Z" },
          ],
          next: null,
        }),
        { status: 200 },
      );
    const client = createPostHogQueryClient({ queryKey: "phx_x", projectId: "1", fetch: mockFetch });
    const events = await client.fetchOverrides({ since: new Date() });
    expect(events).toHaveLength(1);
    expect(events[0]!.prompt).toBe("real prompt here");
  });
});
