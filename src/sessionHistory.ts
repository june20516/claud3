import { styleText } from "node:util";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { summarizeToolInput } from "./events.js";
import { renderMarkdownLine } from "./markdown.js";

/** resume할 때 보여 줄 이전 대화 줄 수. */
export const HISTORY_LINE_LIMIT = 100;

export type SessionMessageReader = (sessionId: string) => Promise<SessionMessage[]>;

/** Claude Code가 남기는 슬래시 명령 기록. 대화 내용이 아니므로 보이지 않는다. */
const COMMAND_RECORD_PATTERN = /^<(command-|local-command-)/;

type ContentBlock = { type: string; text?: unknown; name?: unknown; input?: unknown };

function contentOf(message: SessionMessage): unknown {
  const body = message.message;
  return typeof body === "object" && body !== null && "content" in body ? body.content : undefined;
}

function blocksOf(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(
    (block): block is ContentBlock => typeof block === "object" && block !== null && typeof block.type === "string",
  );
}

/** 화면에 보일 메시지인지. 서브에이전트, 메타, compact 요약은 뺀다. */
function isVisible(message: SessionMessage): boolean {
  const flags: Record<string, unknown> = message;
  return (
    message.type !== "system" &&
    message.parent_tool_use_id === null &&
    flags.is_meta !== true &&
    flags.isCompactSummary !== true
  );
}

function userText(content: unknown): string | undefined {
  const text =
    typeof content === "string"
      ? content
      : blocksOf(content)
          .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
          .join("\n");
  const trimmed = text.trim();
  return trimmed === "" || COMMAND_RECORD_PATTERN.test(trimmed) ? undefined : trimmed;
}

function userBlock(text: string): string[] {
  const [first = "", ...rest] = text.split("\n");
  return [`${styleText("dim", "> ")}${first}`, ...rest];
}

function assistantTextBlock(text: string): string[] | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  const state = { inCodeBlock: false };
  return trimmed.split("\n").map((line) => renderMarkdownLine(line, state));
}

function toolBlock(block: ContentBlock): string[] {
  const name = typeof block.name === "string" ? block.name : "도구";
  const input = typeof block.input === "object" && block.input !== null ? (block.input as Record<string, unknown>) : {};
  return [`⏺ ${name}(${summarizeToolInput(name, input)})`];
}

/** 메시지 하나를 화면 블록들로 바꾼다. 블록 사이에는 빈 줄이 들어간다. */
function blocksOfMessage(message: SessionMessage): string[][] {
  const content = contentOf(message);
  if (message.type === "user") {
    const text = userText(content);
    return text === undefined ? [] : [userBlock(text)];
  }
  return blocksOf(content).flatMap((block) => {
    if (block.type === "text" && typeof block.text === "string") {
      const lines = assistantTextBlock(block.text);
      return lines === undefined ? [] : [lines];
    }
    return block.type === "tool_use" ? [toolBlock(block)] : [];
  });
}

/** 세션 기록을 대화 화면과 같은 모양의 줄로 바꾸고 마지막 limit 줄만 남긴다. */
export function historyLines(messages: readonly SessionMessage[], limit = HISTORY_LINE_LIMIT): string[] {
  const blocks = messages.filter(isVisible).flatMap(blocksOfMessage);
  const lines = blocks.flatMap((block, index) => (index === 0 ? block : ["", ...block]));
  const tail = lines.slice(-limit);
  while (tail[0] === "") {
    tail.shift();
  }
  return tail;
}

export async function loadHistoryLines(
  sessionId: string,
  readMessages: SessionMessageReader = (id) => getSessionMessages(id),
): Promise<string[]> {
  return historyLines(await readMessages(sessionId));
}
