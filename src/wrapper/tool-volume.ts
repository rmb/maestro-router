// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0

export const TOOL_VOLUME_THRESHOLD = 4;

export type ToolVolumeState = {
  toolCallsThisTurn: number;
};

export function createToolVolumeState(): ToolVolumeState {
  return { toolCallsThisTurn: 0 };
}

/** Call when a new user text message starts a new turn. */
export function resetToolVolume(state: ToolVolumeState): void {
  state.toolCallsThisTurn = 0;
}

/** Call once per tool_use block seen in an assistant frame. */
export function incrementToolVolume(state: ToolVolumeState, count: number): void {
  state.toolCallsThisTurn += count;
}

/** Returns true when the current turn has exceeded the tool volume threshold. */
export function isHighVolumeTurn(state: ToolVolumeState): boolean {
  return state.toolCallsThisTurn >= TOOL_VOLUME_THRESHOLD;
}

/**
 * Upgrade a model string one tier: haiku → sonnet → opus.
 * Returns the same model if already at opus or unrecognized.
 */
export function upgradeModel(model: string): string {
  if (model.includes("haiku")) return "sonnet";
  if (model.includes("sonnet")) return "opus";
  return model;
}
