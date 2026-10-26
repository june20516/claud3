import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { renderMarkdownLine } from "../../markdown.js";
import { describePermissionMode } from "../../permissionModes.js";
import type { UiEvent } from "../../types.js";
import { CREDIT_HINT } from "../plain.js";

export type NoticeTone = "info" | "error" | "dim";

/** 도구 호출 줄. diff는 그릴 때 input으로 만든다. */
export type ToolItem = { kind: "tool"; id: number; name: string; summary: string; input: Record<string, unknown> };
/** 마크다운을 입힌 응답 줄들. attached면 같은 응답의 앞 줄에 빈 줄 없이 붙인다. */
export type AssistantItem = { kind: "assistant"; id: number; text: string; attached: boolean };
/** attached면 바로 앞 항목(도구 줄)에 빈 줄 없이 붙인다. */
export type NoticeItem = { kind: "notice"; id: number; tone: NoticeTone; text: string; attached?: boolean };

/** resume한 세션의 이전 대화. 머리말 아래에 그대로 그린다. */
export type HistoryItem = { kind: "history"; id: number; text: string };

export type TranscriptItem =
  | { kind: "user"; id: number; text: string }
  | AssistantItem
  | ToolItem
  | NoticeItem
  | HistoryItem;

/** 동적 영역에 한 줄로 보이는 실행 중 표시. */
export interface RunningTool {
  toolUseId: string;
  name: string;
  summary: string;
}

/** 진행 중인 응답의 마크다운 렌더 상태. 완성된 줄은 이미 done에 들어가 있다. */
export interface StreamingText {
  /** 아직 줄바꿈이 오지 않은 마지막 줄(원문). */
  pending: string;
  inCodeBlock: boolean;
  /** 이 응답의 줄을 done에 넣은 적이 있는지. */
  started: boolean;
  /** 뒤에 내용이 와야 내보낼 빈 줄 수. 응답 끝의 빈 줄은 버린다. */
  heldBlankLines: number;
}

/** 응답을 기다리는 동안 진행 표시 줄에 보일 문구. 턴마다 하나를 고른다. */
export const WAITING_VERBS = [
  "궁리하는 중",
  "곰곰이 생각하는 중",
  "끄적이는 중",
  "뚝딱이는 중",
  "골똘히 들여다보는 중",
  "꿰어 맞추는 중",
  "버무리는 중",
  "다듬는 중",
  "주물럭거리는 중",
  "엮어 내는 중",
] as const;

/** 프롬프트를 보낸 뒤 turn_result가 올 때까지의 진행 상태. */
export interface TurnProgress {
  startedAt: number;
  verb: string;
  /** 이번 턴에 보낸 토큰(입력, 캐시 포함). */
  inputTokens: number;
  /** 이번 턴에 받은 토큰(받는 중이면 추정). */
  outputTokens: number;
}

export interface TranscriptState {
  /** Static으로 한 번만 그리는 확정 항목 */
  done: TranscriptItem[];
  /** 실행 중인 도구 */
  running: RunningTool[];
  /** 진행 중인 응답. 동적 영역에는 pending 한 줄만 그린다. */
  streaming?: StreamingText;
  nextId: number;
  sessionCostUsd: number;
  model?: string;
  permissionMode?: PermissionMode;
  header?: string;
  /** 진행 중인 턴. 없으면 응답을 기다리고 있지 않다. */
  turn?: TurnProgress;
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

const EMPTY_STREAM: StreamingText = { pending: "", inCodeBlock: false, started: false, heldBlankLines: 0 };

/** 렌더한 줄들을 응답 항목으로 done 끝에 추가한다. */
function appendAssistant(state: TranscriptState, lines: string[], attached: boolean): TranscriptState {
  const item: AssistantItem = { kind: "assistant", id: state.nextId, text: lines.join("\n"), attached };
  return { ...state, done: [...state.done, item], nextId: state.nextId + 1 };
}

/**
 * 응답 조각을 받아 완성된 줄은 바로 done(Static)에 확정하고 마지막 조각만 남긴다.
 * 동적 영역이 터미널 높이를 넘지 않게 하고, delta마다 처음부터 다시 렌더하지 않는다.
 */
function appendTextDelta(state: TranscriptState, text: string): TranscriptState {
  const stream = state.streaming ?? EMPTY_STREAM;
  const rawLines = (stream.pending + text).split("\n");
  const pending = rawLines.pop() ?? "";
  const lineState = { inCodeBlock: stream.inCodeBlock };
  const lines = [
    ...Array<string>(stream.heldBlankLines).fill(""),
    ...rawLines.map((line) => renderMarkdownLine(line, lineState)),
  ];
  let heldBlankLines = 0;
  while (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
    heldBlankLines++;
  }
  const next = lines.length === 0 ? state : appendAssistant(state, lines, stream.started);
  return {
    ...next,
    streaming: {
      pending,
      inCodeBlock: lineState.inCodeBlock,
      started: stream.started || lines.length > 0,
      heldBlankLines,
    },
  };
}

/** 진행 중 응답의 남은 조각을 done으로 확정한다. 권한·계획 질문을 띄우기 직전에도 부른다. */
export function commitStreaming(state: TranscriptState): TranscriptState {
  const { streaming } = state;
  if (streaming === undefined) {
    return state;
  }
  const settled: TranscriptState = { ...state, streaming: undefined };
  if (streaming.pending === "") {
    return settled;
  }
  const lines = [
    ...Array<string>(streaming.heldBlankLines).fill(""),
    renderMarkdownLine(streaming.pending, { inCodeBlock: streaming.inCodeBlock }),
  ];
  return appendAssistant(settled, lines, streaming.started);
}

export function addUserInput(state: TranscriptState, text: string): TranscriptState {
  const committed = commitStreaming(state);
  return {
    ...committed,
    done: [...committed.done, { kind: "user", id: committed.nextId, text }],
    nextId: committed.nextId + 1,
  };
}

/** 프롬프트를 보낼 때 턴을 시작한다. 이미 진행 중이면(대기열 입력) 그대로 둔다. 문구는 시작 시각으로 고른다. */
export function startTurn(state: TranscriptState, startedAt: number): TranscriptState {
  if (state.turn !== undefined) {
    return state;
  }
  const verb = WAITING_VERBS[startedAt % WAITING_VERBS.length] ?? WAITING_VERBS[0];
  return { ...state, turn: { startedAt, verb, inputTokens: 0, outputTokens: 0 } };
}

export function addNotice(state: TranscriptState, tone: NoticeTone, text: string): TranscriptState {
  return appendNotice(commitStreaming(state), tone, text);
}

export function reduceTranscript(state: TranscriptState, event: UiEvent): TranscriptState {
  if (event.type === "text_delta") {
    return appendTextDelta(state, event.text);
  }
  // 응답 조각마다 오므로 진행 중인 응답 줄을 확정하지 않는다.
  if (event.type === "token_usage") {
    return state.turn === undefined
      ? state
      : { ...state, turn: { ...state.turn, inputTokens: event.inputTokens, outputTokens: event.outputTokens } };
  }

  const committed = commitStreaming(state);
  switch (event.type) {
    case "session_start":
      return {
        ...committed,
        model: event.model,
        header: `claud3 · API key(${event.apiKeySource}) · Agent SDK · ${event.model}`,
      };
    case "history": {
      const item: HistoryItem = { kind: "history", id: committed.nextId, text: event.lines.join("\n") };
      return { ...committed, done: [...committed.done, item], nextId: committed.nextId + 1 };
    }
    case "tool_start": {
      // plain처럼 도구 줄과 diff는 바로 확정하고, 동적 영역에는 실행 중 표시 한 줄만 둔다.
      const tool: ToolItem = {
        kind: "tool",
        id: committed.nextId,
        name: event.name,
        summary: event.summary,
        input: event.input,
      };
      return {
        ...committed,
        done: [...committed.done, tool],
        running: [...committed.running, { toolUseId: event.toolUseId, name: event.name, summary: event.summary }],
        nextId: committed.nextId + 1,
      };
    }
    case "tool_end": {
      const tool = committed.running.find((item) => item.toolUseId === event.toolUseId);
      if (tool === undefined) {
        return committed;
      }
      const next: TranscriptState = { ...committed, running: committed.running.filter((item) => item !== tool) };
      if (!event.isError) {
        return next;
      }
      const notice: NoticeItem = {
        kind: "notice",
        id: next.nextId,
        tone: "error",
        text: `  ⎿ ${event.summary}`,
        attached: true,
      };
      return { ...next, done: [...next.done, notice], nextId: next.nextId + 1 };
    }
    case "turn_result": {
      let next: TranscriptState = { ...committed, sessionCostUsd: event.totalCostUsd, turn: undefined };
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
      // 연결이 끊기면 turn_result 없이 턴이 끝난다.
      return appendNotice({ ...committed, turn: undefined }, "error", `오류: ${event.message}`);
    case "session_closed": {
      const lines: string[] = [];
      if (event.sessionId) {
        lines.push(`세션 ID: ${event.sessionId}  (이어서: claud3 --resume ${event.sessionId})`);
      }
      lines.push(`누적 비용 ${usd(event.totalCostUsd)}`);
      return appendNotice({ ...committed, turn: undefined }, "info", lines.join("\n"));
    }
  }
}
