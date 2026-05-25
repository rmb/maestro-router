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
