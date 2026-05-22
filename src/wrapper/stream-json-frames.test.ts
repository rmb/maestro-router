// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  parseFrame,
  isUserTextMessage,
  isControlRequest,
  extractPromptText,
  buildSetModelRequest,
  matchesInjectedRequestId,
  MAESTRO_REQUEST_ID_PREFIX,
  isToolResultMessage,
  extractToolUseIds,
  extractToolUseBlocks,
} from "./stream-json-frames.js";

describe("parseFrame", () => {
  test("returns null on non-JSON lines", () => {
    expect(parseFrame("")).toBeNull();
    expect(parseFrame("   ")).toBeNull();
    expect(parseFrame("not json")).toBeNull();
    expect(parseFrame("{broken")).toBeNull();
  });

  test("parses valid JSON object", () => {
    const f = parseFrame('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}');
    expect(f).not.toBeNull();
    expect(f?.type).toBe("user");
  });

  test("returns null for JSON arrays / primitives", () => {
    expect(parseFrame("[]")).toBeNull();
    expect(parseFrame('"string"')).toBeNull();
    expect(parseFrame("42")).toBeNull();
  });
});

describe("isUserTextMessage", () => {
  test("recognizes well-formed user text frame", () => {
    const f = parseFrame('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}')!;
    expect(isUserTextMessage(f)).toBe(true);
  });

  test("rejects user frames whose content is only a tool_result", () => {
    const f = parseFrame('{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]}}')!;
    expect(isUserTextMessage(f)).toBe(false);
  });

  test("rejects non-user frames", () => {
    const f = parseFrame('{"type":"assistant","message":{}}')!;
    expect(isUserTextMessage(f)).toBe(false);
  });
});

describe("isControlRequest", () => {
  test("recognizes a control_request frame", () => {
    const f = parseFrame('{"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}}')!;
    expect(isControlRequest(f)).toBe(true);
  });

  test("rejects user and assistant frames", () => {
    const f1 = parseFrame('{"type":"user","message":{"role":"user","content":[]}}')!;
    const f2 = parseFrame('{"type":"assistant","message":{}}')!;
    expect(isControlRequest(f1)).toBe(false);
    expect(isControlRequest(f2)).toBe(false);
  });
});

describe("extractPromptText", () => {
  test("returns the first text block content", () => {
    const f = parseFrame('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello world"}]}}')!;
    expect(extractPromptText(f)).toBe("hello world");
  });

  test("returns the text even when other content blocks precede", () => {
    const f = parseFrame('{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"},{"type":"text","text":"second"}]}}')!;
    expect(extractPromptText(f)).toBe("second");
  });

  test("returns null when no text block exists", () => {
    const f = parseFrame('{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]}}')!;
    expect(extractPromptText(f)).toBeNull();
  });
});

describe("buildSetModelRequest", () => {
  test("emits a control_request with maestro-prefixed request_id", () => {
    const r = buildSetModelRequest("haiku", 7);
    expect(r.type).toBe("control_request");
    expect(r.request_id.startsWith(MAESTRO_REQUEST_ID_PREFIX)).toBe(true);
    expect(r.request.subtype).toBe("set_model");
    expect(r.request.model).toBe("haiku");
  });

  test("each call produces a unique request_id", () => {
    const a = buildSetModelRequest("haiku", 1);
    const b = buildSetModelRequest("haiku", 2);
    expect(a.request_id).not.toBe(b.request_id);
  });
});

describe("matchesInjectedRequestId", () => {
  test("true when control_response request_id has the maestro prefix", () => {
    const f = parseFrame(`{"type":"control_response","response":{"request_id":"${MAESTRO_REQUEST_ID_PREFIX}5","subtype":"success"}}`)!;
    expect(matchesInjectedRequestId(f)).toBe(true);
  });

  test("false when control_response request_id is from the SDK host", () => {
    const f = parseFrame('{"type":"control_response","response":{"request_id":"sdk-host-id","subtype":"success"}}')!;
    expect(matchesInjectedRequestId(f)).toBe(false);
  });

  test("false for non-control-response frames", () => {
    const f = parseFrame('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"x"}]}}')!;
    expect(matchesInjectedRequestId(f)).toBe(false);
  });
});

describe("isToolResultMessage", () => {
  test("returns true for user frame whose content contains a tool_result block", () => {
    const f = parseFrame(
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"file contents"}]}}',
    )!;
    expect(isToolResultMessage(f)).toBe(true);
  });

  test("returns false for a text-only user message", () => {
    const f = parseFrame(
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
    )!;
    expect(isToolResultMessage(f)).toBe(false);
  });

  test("returns false for a non-user frame", () => {
    const f = parseFrame(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
    )!;
    expect(isToolResultMessage(f)).toBe(false);
  });

  test("returns false for a user frame with no message", () => {
    const f = parseFrame('{"type":"user"}')!;
    expect(isToolResultMessage(f)).toBe(false);
  });

  test("returns true when tool_result appears alongside a text block", () => {
    const f = parseFrame(
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_02","content":"data"},{"type":"text","text":"note"}]}}',
    )!;
    expect(isToolResultMessage(f)).toBe(true);
  });
});

describe("extractToolUseIds", () => {
  test("returns array of tool_use_id strings from tool_result blocks", () => {
    const f = parseFrame(
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"res"}]}}',
    )!;
    expect(extractToolUseIds(f)).toEqual(["toolu_01"]);
  });

  test("returns multiple ids when multiple tool_result blocks are present", () => {
    const f = parseFrame(
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"a"},{"type":"tool_result","tool_use_id":"toolu_02","content":"b"}]}}',
    )!;
    expect(extractToolUseIds(f)).toEqual(["toolu_01", "toolu_02"]);
  });

  test("returns empty array for a text-only user message", () => {
    const f = parseFrame(
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
    )!;
    expect(extractToolUseIds(f)).toEqual([]);
  });

  test("returns empty array when content is absent", () => {
    const f = parseFrame('{"type":"user","message":{}}')!;
    expect(extractToolUseIds(f)).toEqual([]);
  });
});

describe("extractToolUseBlocks", () => {
  test("returns id+name pairs from tool_use blocks in an assistant frame", () => {
    const f = parseFrame(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Read","input":{"path":"index.ts"}}]}}',
    )!;
    expect(extractToolUseBlocks(f)).toEqual([{ id: "toolu_01", name: "Read" }]);
  });

  test("returns multiple entries when multiple tool_use blocks are present", () => {
    const f = parseFrame(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Read","input":{}},{"type":"tool_use","id":"toolu_02","name":"Grep","input":{}}]}}',
    )!;
    expect(extractToolUseBlocks(f)).toEqual([
      { id: "toolu_01", name: "Read" },
      { id: "toolu_02", name: "Grep" },
    ]);
  });

  test("returns empty array for a non-assistant frame", () => {
    const f = parseFrame(
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
    )!;
    expect(extractToolUseBlocks(f)).toEqual([]);
  });

  test("returns empty array when content contains no tool_use blocks", () => {
    const f = parseFrame(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I will now read…"}]}}',
    )!;
    expect(extractToolUseBlocks(f)).toEqual([]);
  });

  test("skips tool_use blocks missing id or name", () => {
    const f = parseFrame(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01"},{"type":"tool_use","name":"Read"},{"type":"tool_use","id":"toolu_03","name":"Glob","input":{}}]}}',
    )!;
    expect(extractToolUseBlocks(f)).toEqual([{ id: "toolu_03", name: "Glob" }]);
  });
});
