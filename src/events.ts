import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UiEvent } from "./types.js";

const SUMMARY_MAX_LENGTH = 80;

function truncate(text: string): string {
  if (text.length <= SUMMARY_MAX_LENGTH) {
    return text;
  }
  return `${text.slice(0, SUMMARY_MAX_LENGTH - 1)}…`;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function summarizeQuestions(questions: unknown): string {
  if (!Array.isArray(questions)) {
    return "";
  }
  const [first]: unknown[] = questions;
  const firstQuestion =
    typeof first === "object" && first !== null && "question" in first && typeof first.question === "string"
      ? first.question
      : "";
  return questions.length > 1 ? `질문 ${questions.length}개: ${firstQuestion}` : firstQuestion;
}

export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return truncate(firstLine(stringField(input, "command") ?? ""));
    case "Read":
    case "Edit":
    case "Write":
      return truncate(stringField(input, "file_path") ?? "");
    case "Grep":
    case "Glob":
      return truncate(stringField(input, "pattern") ?? "");
    case "AskUserQuestion":
      return truncate(summarizeQuestions(input.questions));
    default:
      return truncate(JSON.stringify(input));
  }
}

interface ContentBlockLike {
  type?: unknown;
  [key: string]: unknown;
}

function contentBlocks(content: unknown): ContentBlockLike[] {
  return Array.isArray(content) ? (content as ContentBlockLike[]) : [];
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  const textBlock = contentBlocks(content).find((block) => block.type === "text" && typeof block.text === "string");
  return typeof textBlock?.text === "string" ? textBlock.text : "";
}

function resultErrorMessage(message: SDKResultMessage): string | undefined {
  if (message.subtype === "success") {
    return message.is_error ? message.result : undefined;
  }
  return message.errors.length > 0 ? message.errors.join("\n") : message.subtype;
}

/**
 * SDK 메시지를 화면용 이벤트로 바꾸는 매퍼를 만든다.
 * SDK의 total_cost_usd는 query 시작부터의 누적값이므로 직전 값과의 차이를 턴 비용으로 본다.
 */
export function createEventMapper(initialTotalUsd = 0): (message: SDKMessage) => UiEvent[] {
  let hasStarted = false;
  let previousQueryCostUsd = 0;

  return (message) => {
    switch (message.type) {
      case "system": {
        if (message.subtype !== "init" || hasStarted) {
          return [];
        }
        hasStarted = true;
        return [
          { type: "session_start", sessionId: message.session_id, model: message.model, apiKeySource: message.apiKeySource },
        ];
      }

      case "stream_event": {
        const event = message.event;
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          return [{ type: "text_delta", text: event.delta.text }];
        }
        return [];
      }

      case "assistant":
        return contentBlocks(message.message.content).flatMap((block): UiEvent[] => {
          if (block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") {
            return [];
          }
          const input = (block.input ?? {}) as Record<string, unknown>;
          return [{ type: "tool_start", toolUseId: block.id, name: block.name, summary: summarizeToolInput(block.name, input), input }];
        });

      case "user":
        return contentBlocks(message.message.content).flatMap((block): UiEvent[] => {
          if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
            return [];
          }
          return [
            {
              type: "tool_end",
              toolUseId: block.tool_use_id,
              isError: block.is_error === true,
              summary: truncate(firstLine(toolResultText(block.content))),
            },
          ];
        });

      case "result": {
        const costUsd = message.total_cost_usd - previousQueryCostUsd;
        previousQueryCostUsd = message.total_cost_usd;
        const errorMessage = resultErrorMessage(message);
        const isError = message.is_error || message.subtype !== "success";
        return [
          {
            type: "turn_result",
            costUsd,
            totalCostUsd: initialTotalUsd + message.total_cost_usd,
            isError,
            ...(errorMessage === undefined ? {} : { errorMessage }),
          },
        ];
      }

      default:
        return [];
    }
  };
}
