// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0
//
// Pure stream-json frame parsing for the SDK-aware proxy. No i/o — just
// JSON shape detection. The proxy uses these to decide which lines to
// classify, which to inject around, and which to filter from output.

export const MAESTRO_REQUEST_ID_PREFIX = "maestro-";

export type Frame = Record<string, unknown> & { type?: string };

export type SetModelRequest = {
  type: "control_request";
  request_id: string;
  request: { subtype: "set_model"; model: string };
};

/**
 * P3: undocumented control_request the Claude Code SDK accepts to cap thinking
 * tokens per turn. Reverse-engineered from the bundled cli.js zod schemas.
 * `null` means uncapped. Use to apply effort routing in sdk-proxy mode (where
 * spawn-time `--effort` is not available).
 */
export type SetMaxThinkingTokensRequest = {
  type: "control_request";
  request_id: string;
  request: { subtype: "set_max_thinking_tokens"; max_thinking_tokens: number | null };
};

/** Parse a single line as a JSON object frame. Returns null on garbage. */
export function parseFrame(line: string): Frame | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed) as unknown;
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
    return obj as Frame;
  } catch {
    return null;
  }
}

/** A user-role message whose content array contains at least one text block. */
export function isUserTextMessage(frame: Frame): boolean {
  if (frame.type !== "user") return false;
  const message = frame.message;
  if (typeof message !== "object" || message === null) return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) =>
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string",
  );
}

export function isControlRequest(frame: Frame): boolean {
  return frame.type === "control_request";
}

export function isControlResponse(frame: Frame): boolean {
  return frame.type === "control_response";
}

/** Pull the first text block from a user message. Caller pre-checks isUserTextMessage. */
export function extractPromptText(frame: Frame): string | null {
  const content = (frame.message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return null;
  for (const b of content) {
    if (
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string"
    ) {
      return (b as { text: string }).text;
    }
  }
  return null;
}

/** Build a set_model control_request with a maestro-prefixed id. */
export function buildSetModelRequest(model: string, seq: number): SetModelRequest {
  return {
    type: "control_request",
    request_id: `${MAESTRO_REQUEST_ID_PREFIX}${seq}`,
    request: { subtype: "set_model", model },
  };
}

/**
 * Build a set_max_thinking_tokens control_request. P3.
 * @param maxThinkingTokens - cap (e.g. 2048 for low effort), or null for uncapped.
 */
export function buildSetThinkingTokensRequest(
  maxThinkingTokens: number | null,
  seq: number,
): SetMaxThinkingTokensRequest {
  return {
    type: "control_request",
    request_id: `${MAESTRO_REQUEST_ID_PREFIX}${seq}`,
    request: { subtype: "set_max_thinking_tokens", max_thinking_tokens: maxThinkingTokens },
  };
}

/**
 * Map Maestro effort levels to thinking-token caps. Aligned with the public
 * thinking-token tiers exposed by `--effort`:
 *   low    →  2048   (minimal think; cuts cost on misrouted-up turns)
 *   medium →  8192   (standard)
 *   high   → 24000   (deep)
 *   xhigh  → 32000
 *   max    →  null   (uncapped, full budget)
 */
export function effortToThinkingTokens(effort: string): number | null {
  switch (effort) {
    case "low": return 2048;
    case "medium": return 8192;
    case "high": return 24000;
    case "xhigh": return 32000;
    case "max": return null;
    default: return 8192;
  }
}

/** True when a control_response is responding to one of our injected requests. */
export function matchesInjectedRequestId(frame: Frame): boolean {
  if (frame.type !== "control_response") return false;
  const response = frame.response;
  if (typeof response !== "object" || response === null) return false;
  const id = (response as { request_id?: unknown }).request_id;
  return typeof id === "string" && id.startsWith(MAESTRO_REQUEST_ID_PREFIX);
}

/** A user-role message whose content array contains at least one tool_result block. */
export function isToolResultMessage(frame: Frame): boolean {
  if (frame.type !== "user") return false;
  const message = frame.message;
  if (typeof message !== "object" || message === null) return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) =>
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "tool_result",
  );
}

/** Extract tool_use_id strings from all tool_result blocks in a user frame. */
export function extractToolUseIds(frame: Frame): string[] {
  const message = frame.message;
  if (typeof message !== "object" || message === null) return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const b of content) {
    if (
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "tool_result" &&
      typeof (b as { tool_use_id?: unknown }).tool_use_id === "string"
    ) {
      ids.push((b as { tool_use_id: string }).tool_use_id);
    }
  }
  return ids;
}

/** Extract {id, name} pairs from all tool_use blocks in an assistant frame. */
export function extractToolUseBlocks(frame: Frame): Array<{ id: string; name: string }> {
  if (frame.type !== "assistant") return [];
  const message = frame.message;
  if (typeof message !== "object" || message === null) return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const blocks: Array<{ id: string; name: string }> = [];
  for (const b of content) {
    if (
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "tool_use" &&
      typeof (b as { id?: unknown }).id === "string" &&
      typeof (b as { name?: unknown }).name === "string"
    ) {
      blocks.push({
        id: (b as { id: string }).id,
        name: (b as { name: string }).name,
      });
    }
  }
  return blocks;
}

/**
 * P6: extract a rate-limit signal from a verbose-mode `rate_limit_event` frame.
 * Returns null when the frame is not a rate-limit event. Shape verified against
 * Claude Code CLI 2.x — see cli.js bundled zod schemas.
 */
export type RateLimitInfo = {
  status: "allowed" | "limited" | string;
  resetsAt: number;
  rateLimitType: "five_hour" | "weekly" | string;
  overageStatus?: "allowed" | "rejected" | string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
};

export function extractRateLimitInfo(frame: Frame): RateLimitInfo | null {
  if (frame.type !== "rate_limit_event") return null;
  const info = (frame as { rate_limit_info?: unknown }).rate_limit_info;
  if (typeof info !== "object" || info === null) return null;
  const i = info as Record<string, unknown>;
  if (typeof i["status"] !== "string") return null;
  if (typeof i["resetsAt"] !== "number") return null;
  if (typeof i["rateLimitType"] !== "string") return null;
  return {
    status: i["status"],
    resetsAt: i["resetsAt"],
    rateLimitType: i["rateLimitType"],
    ...(typeof i["overageStatus"] === "string" ? { overageStatus: i["overageStatus"] } : {}),
    ...(typeof i["overageDisabledReason"] === "string"
      ? { overageDisabledReason: i["overageDisabledReason"] }
      : {}),
    ...(typeof i["isUsingOverage"] === "boolean" ? { isUsingOverage: i["isUsingOverage"] } : {}),
  };
}

/**
 * Apply a transformation function to all tool_result blocks in a user frame.
 * Returns a new frame with tool_result content blocks modified.
 * Used for I1: line-number stripping and other tool-result post-processing.
 *
 * Note: shallow-copies frames. Assumes transforms only mutate the content string,
 * not nested block structure.
 */
export function transformToolResults(
  frame: Frame,
  transform: (content: string) => string,
): Frame {
  if (frame.type !== "user") return frame;

  const message = frame.message;
  if (typeof message !== "object" || message === null) return frame;

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return frame;

  // Create a shallow copy of the frame and message
  const newFrame = { ...frame };
  const newMessage = { ...message };
  const newContent = content.map((block) => {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "tool_result" &&
      typeof (block as { content?: unknown }).content === "string"
    ) {
      return {
        ...block,
        content: transform((block as { content: string }).content),
      };
    }
    return block;
  });

  (newMessage as { content: unknown }).content = newContent;
  (newFrame as { message: unknown }).message = newMessage;
  return newFrame;
}
