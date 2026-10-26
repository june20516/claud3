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

/** 받는 중인 응답의 토큰 추정에 쓰는 글자 수. 정확한 값은 응답이 끝날 때 message_delta로 온다. */
const ESTIMATED_CHARS_PER_TOKEN = 4;

/** 받는 중인 응답 조각의 글자 수. 텍스트·도구 입력·생각 조각을 센다. */
function deltaLength(delta: { type: string }): number {
  if ("text" in delta && typeof delta.text === "string") {
    return delta.text.length;
  }
  if ("partial_json" in delta && typeof delta.partial_json === "string") {
    return delta.partial_json.length;
  }
  if ("thinking" in delta && typeof delta.thinking === "string") {
    return delta.thinking.length;
  }
  return 0;
}

/**
 * SDK 메시지를 화면용 이벤트로 바꾸는 매퍼를 만든다.
 * SDK의 total_cost_usd는 query 시작부터의 누적값이므로 직전 값과의 차이를 턴 비용으로 본다.
 */
export function createEventMapper(initialTotalUsd = 0): (message: SDKMessage) => UiEvent[] {
  let hasStarted = false;
  let previousQueryCostUsd = 0;
  // 이번 턴의 토큰. 턴 안의 API 호출(도구 사용마다 한 번)을 모두 더한다.
  let turnInputTokens = 0;
  let finishedOutputTokens = 0;
  /** 진행 중인 응답에서 받은 글자 수. message_delta의 정확한 값이 오기 전까지 토큰을 추정한다. */
  let streamingChars = 0;

  const tokenUsage = (): UiEvent => ({
    type: "token_usage",
    inputTokens: turnInputTokens,
    outputTokens: finishedOutputTokens + Math.ceil(streamingChars / ESTIMATED_CHARS_PER_TOKEN),
  });

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
        if (event.type === "message_start") {
          const usage = event.message.usage;
          turnInputTokens +=
            usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
          streamingChars = 0;
          return [tokenUsage()];
        }
        if (event.type === "message_delta") {
          finishedOutputTokens += event.usage.output_tokens;
          streamingChars = 0;
          return [tokenUsage()];
        }
        if (event.type === "content_block_delta") {
          streamingChars += deltaLength(event.delta);
          const textEvents: UiEvent[] =
            event.delta.type === "text_delta" ? [{ type: "text_delta", text: event.delta.text }] : [];
          return [...textEvents, tokenUsage()];
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
        turnInputTokens = 0;
        finishedOutputTokens = 0;
        streamingChars = 0;
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
