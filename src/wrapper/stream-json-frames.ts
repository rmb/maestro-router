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
