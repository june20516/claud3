export type UiEvent =
  | { type: "session_start"; sessionId: string; model: string; apiKeySource: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolUseId: string; name: string; summary: string; input: Record<string, unknown> }
  | { type: "tool_end"; toolUseId: string; isError: boolean; summary: string }
  | { type: "turn_result"; costUsd: number; totalCostUsd: number; isError: boolean; errorMessage?: string }
  | { type: "error"; message: string }
  | { type: "session_closed"; sessionId?: string; totalCostUsd: number };

export interface PermissionRequest {
  toolName: string;
  summary: string;
  /** SDK가 이 권한 요청을 취소하면 abort된다. */
  signal?: AbortSignal;
}

export type PermissionDecision = "allow" | "deny" | "always";

export type PermissionPrompter = (request: PermissionRequest) => Promise<PermissionDecision>;
