import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { blocksOf, contentOf, isVisible, userText } from "../../sessionHistory.js";
import { SEGMENT_LIMITS } from "../tuning.js";

export interface SegmentLimits {
  userChars: number;
  assistantChars: number;
  totalChars: number;
}

/** 기억 기록에 넘길 대화 구간. */
export interface Segment {
  /** "사용자: …", "<인격 이름>: …", "⏺ 도구 (성공|실패|결과 없음)" 줄. */
  lines: string[];
  /** 커서 이전의 마지막 사용자 입력·응답 2쌍(같은 형식). 맥락 참고용이며 기록 대상이 아니다. */
  context: string[];
  /** 원본 목록의 마지막 메시지 uuid. 보이지 않는 메시지 뒤에서 다시 시작하지 않도록 거르기 전 기준이다. */
  lastUuid: string;
  userInputs: number;
}

const CONTEXT_PAIRS = 2;
const OMITTED_LINE = "(앞부분 생략)";
const USER_PREFIX = "사용자: ";

function clip(text: string, limit: number): string {
  const characters = [...text];
  return characters.length > limit ? `${characters.slice(0, limit).join("")}…` : text;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isCompactSummary(message: SessionMessage): boolean {
  const flags: Record<string, unknown> = message;
  return flags.isCompactSummary === true;
}

/** 커서 다음 메시지의 위치. 커서가 null이면 0, 못 찾으면(압축으로 사라짐) 마지막 compact 요약 다음. */
function startIndex(messages: readonly SessionMessage[], cursor: string | null): number {
  if (cursor === null) {
    return 0;
  }
  const cursorIndex = messages.findIndex((message) => message.uuid === cursor);
  if (cursorIndex >= 0) {
    return cursorIndex + 1;
  }
  return messages.findLastIndex(isCompactSummary) + 1;
}

/** tool_use id → 성공 여부. 결과가 없는 도구는 들어 있지 않다. */
function toolOutcomes(messages: readonly SessionMessage[]): Map<string, boolean> {
  const outcomes = new Map<string, boolean>();
  for (const message of messages) {
    for (const block of blocksOf(contentOf(message))) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        outcomes.set(block.tool_use_id, block.is_error !== true);
      }
    }
  }
  return outcomes;
}

interface Line {
  text: string;
  fromUser: boolean;
}

function linesOf(
  messages: readonly SessionMessage[],
  speakerName: string,
  limits: SegmentLimits,
  outcomes: Map<string, boolean>,
  includeTools: boolean,
): Line[] {
  return messages.filter(isVisible).flatMap((message): Line[] => {
    const content = contentOf(message);
    if (message.type === "user") {
      const text = userText(content);
      return text === undefined ? [] : [{ text: `${USER_PREFIX}${clip(oneLine(text), limits.userChars)}`, fromUser: true }];
    }
    return blocksOf(content).flatMap((block): Line[] => {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
        return [{ text: `${speakerName}: ${clip(oneLine(block.text), limits.assistantChars)}`, fromUser: false }];
      }
      if (includeTools && block.type === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "도구";
        const outcome = typeof block.id === "string" ? outcomes.get(block.id) : undefined;
        const label = outcome === undefined ? "결과 없음" : outcome ? "성공" : "실패";
        return [{ text: `⏺ ${name} (${label})`, fromUser: false }];
      }
      return [];
    });
  });
}

/** 앞쪽 줄부터 버려 합계가 totalChars 이하가 되게 한다. 버렸으면 맨 앞에 생략 표시. */
function fitTotal(lines: string[], totalChars: number): string[] {
  let total = lines.reduce((sum, line) => sum + [...line].length, 0);
  let start = 0;
  while (total > totalChars && start < lines.length) {
    total -= [...(lines[start] ?? "")].length;
    start++;
  }
  return start === 0 ? lines : [OMITTED_LINE, ...lines.slice(start)];
}

/** 커서 이전의 마지막 사용자 입력 CONTEXT_PAIRS개부터 끝까지(도구 제외). */
function contextLines(lines: Line[]): string[] {
  const userIndexes = lines.flatMap((line, index) => (line.fromUser ? [index] : []));
  const from = userIndexes.at(-CONTEXT_PAIRS) ?? 0;
  return lines.slice(from).map((line) => line.text);
}

/**
 * 커서 다음부터 끝까지의 대화 구간. 커서 뒤에 메시지가 없으면 undefined.
 * 사용자 입력과 응답 텍스트는 잘라서 넣고, 도구는 이름과 성공·실패만 넣는다.
 */
export function buildSegment(
  messages: readonly SessionMessage[],
  cursor: string | null,
  speakerName: string,
  limits: SegmentLimits = SEGMENT_LIMITS,
): Segment | undefined {
  const start = startIndex(messages, cursor);
  const last = messages.at(-1);
  if (start >= messages.length || last === undefined) {
    return undefined;
  }
  const outcomes = toolOutcomes(messages);
  const segmentLines = linesOf(messages.slice(start), speakerName, limits, outcomes, true);
  const before = cursor === null ? [] : linesOf(messages.slice(0, start), speakerName, limits, outcomes, false);
  return {
    lines: fitTotal(segmentLines.map((line) => line.text), limits.totalChars),
    context: contextLines(before),
    lastUuid: last.uuid,
    userInputs: segmentLines.filter((line) => line.fromUser).length,
  };
}
