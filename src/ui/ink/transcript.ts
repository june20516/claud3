import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { describePermissionMode } from "../../permissionModes.js";
import type { UiEvent } from "../../types.js";
import { CREDIT_HINT } from "../plain.js";

export type NoticeTone = "info" | "error" | "dim";

export type ToolItem = {
  kind: "tool";
  id: number;
  toolUseId: string;
  name: string;
  summary: string;
  input: Record<string, unknown>;
  status: "running" | "done" | "error";
  errorSummary?: string;
};
export type AssistantItem = { kind: "assistant"; id: number; text: string };
export type NoticeItem = { kind: "notice"; id: number; tone: NoticeTone; text: string };

export type TranscriptItem = { kind: "user"; id: number; text: string } | AssistantItem | ToolItem | NoticeItem;

export interface TranscriptState {
  /** Static으로 그리는 확정 항목 */
  done: TranscriptItem[];
  /** 실행 중인 도구 */
  running: ToolItem[];
  /** 진행 중인 응답 */
  streaming?: AssistantItem;
  nextId: number;
  sessionCostUsd: number;
  model?: string;
  permissionMode?: PermissionMode;
  header?: string;
}

export const initialTranscript: TranscriptState = {
  done: [],
  running: [],
  nextId: 0,
  sessionCostUsd: 0,
};

function usd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

/** notice를 done 끝에 추가한다. id는 nextId에서 받는다. */
function appendNotice(state: TranscriptState, tone: NoticeTone, text: string): TranscriptState {
  const notice: NoticeItem = { kind: "notice", id: state.nextId, tone, text };
  return { ...state, done: [...state.done, notice], nextId: state.nextId + 1 };
}

/** 진행 중 응답을 done으로 확정한다. 권한·계획 질문을 띄우기 직전에 부른다. */
export function commitStreaming(state: TranscriptState): TranscriptState {
  const { streaming } = state;
  if (streaming === undefined) {
    return state;
  }
  return { ...state, done: [...state.done, streaming], streaming: undefined };
}

export function addUserInput(state: TranscriptState, text: string): TranscriptState {
  const committed = commitStreaming(state);
  return {
    ...committed,
    done: [...committed.done, { kind: "user", id: committed.nextId, text }],
    nextId: committed.nextId + 1,
  };
}

export function addNotice(state: TranscriptState, tone: NoticeTone, text: string): TranscriptState {
  return appendNotice(commitStreaming(state), tone, text);
}

export function reduceTranscript(state: TranscriptState, event: UiEvent): TranscriptState {
  if (event.type === "text_delta") {
    if (state.streaming !== undefined) {
      return { ...state, streaming: { ...state.streaming, text: state.streaming.text + event.text } };
    }
    return {
      ...state,
      streaming: { kind: "assistant", id: state.nextId, text: event.text },
      nextId: state.nextId + 1,
    };
  }

  const committed = commitStreaming(state);
  switch (event.type) {
    case "session_start":
      return {
        ...committed,
        model: event.model,
        header: `claud3 · API key(${event.apiKeySource}) · Agent SDK · ${event.model}`,
      };
    case "tool_start":
      return {
        ...committed,
        running: [
          ...committed.running,
          {
            kind: "tool",
            id: committed.nextId,
            toolUseId: event.toolUseId,
            name: event.name,
            summary: event.summary,
            input: event.input,
            status: "running",
          },
        ],
        nextId: committed.nextId + 1,
      };
    case "tool_end": {
      const tool = committed.running.find((item) => item.toolUseId === event.toolUseId);
      if (tool === undefined) {
        return committed;
      }
      // Static에 들어간 항목은 다시 그려지지 않으므로 끝난 뒤에야 done으로 옮긴다.
      const finished: ToolItem = event.isError
        ? { ...tool, status: "error", errorSummary: event.summary }
        : { ...tool, status: "done" };
      return {
        ...committed,
        running: committed.running.filter((item) => item !== tool),
        done: [...committed.done, finished],
      };
    }
    case "turn_result": {
      let next: TranscriptState = { ...committed, sessionCostUsd: event.totalCostUsd };
      if (event.isError && event.errorMessage) {
        next = appendNotice(next, "error", event.errorMessage);
        if (/credit balance/i.test(event.errorMessage)) {
          next = appendNotice(next, "error", CREDIT_HINT);
        }
      }
      return appendNotice(next, "dim", `── ${usd(event.costUsd)} · 누적 ${usd(event.totalCostUsd)}`);
    }
    case "permission_mode":
      return appendNotice(
        { ...committed, permissionMode: event.mode },
        "dim",
        `권한 모드: ${describePermissionMode(event.mode)}`,
      );
    case "error":
      return appendNotice(committed, "error", `오류: ${event.message}`);
    case "session_closed": {
      const lines: string[] = [];
      if (event.sessionId) {
        lines.push(`세션 ID: ${event.sessionId}  (이어서: claud3 --resume ${event.sessionId})`);
      }
      lines.push(`누적 비용 ${usd(event.totalCostUsd)}`);
      return appendNotice(committed, "info", lines.join("\n"));
    }
  }
}
