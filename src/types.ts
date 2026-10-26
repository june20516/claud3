import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

export type UiEvent =
  | { type: "session_start"; sessionId: string; model: string; apiKeySource: string }
  /** resume한 세션의 이전 대화. 화면에 그릴 줄들(응답은 마크다운 스타일 적용). */
  | { type: "history"; lines: string[] }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolUseId: string; name: string; summary: string; input: Record<string, unknown> }
  | { type: "tool_end"; toolUseId: string; isError: boolean; summary: string }
  | { type: "turn_result"; costUsd: number; totalCostUsd: number; isError: boolean; errorMessage?: string }
  | { type: "permission_mode"; mode: PermissionMode }
  | { type: "error"; message: string }
  | { type: "session_closed"; sessionId?: string; totalCostUsd: number };

export interface PermissionRequest {
  toolName: string;
  summary: string;
  /** SDK가 이 권한 요청을 취소하면 abort된다. */
  signal?: AbortSignal;
  /** ExitPlanMode(계획 승인) 요청일 때만 설정된다. 필드가 없어도 빈 객체로 계획 질문임을 알린다. */
  plan?: { text?: string; filePath?: string };
}

/** allowAcceptEdits는 계획 승인에서만 의미가 있다(승인하고 편집 자동 허용 모드로 전환). */
export type PermissionDecision = "allow" | "deny" | "always" | "allowAcceptEdits";

export type PermissionPrompter = (request: PermissionRequest) => Promise<PermissionDecision>;
