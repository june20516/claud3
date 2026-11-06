import type { PostToolUseFailureHookInput, PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { MoodEvent } from "./mood.js";
import {
  ACTION_LINE_PATTERN,
  INSULT_KEYWORDS,
  PRAISE_KEYWORDS,
  REPEAT_SIMILARITY,
  SLOW_TURN_MS,
  TEST_COMMAND_PATTERN,
} from "./tuning.js";

/** 반복 비교용 정규화: 행동 줄을 빼고, 소문자로, 공백을 하나로. */
export function normalizePrompt(text: string): string {
  return text
    .split("\n")
    .filter((line) => !ACTION_LINE_PATTERN.test(line))
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(text: string): Set<string> {
  const characters = [...text];
  const result = new Set<string>();
  for (let index = 0; index < characters.length - 1; index++) {
    result.add(`${characters[index]}${characters[index + 1]}`);
  }
  return result;
}

/** 문자 bigram 집합의 Jaccard 유사도(0~1). 둘 다 비면 1. */
export function bigramSimilarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 && right.size === 0) {
    return a === b ? 1 : 0;
  }
  let shared = 0;
  for (const pair of left) {
    if (right.has(pair)) {
      shared++;
    }
  }
  return shared / (left.size + right.size - shared);
}

function containsAny(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

/** 사용자 입력에서 반복·칭찬·욕 신호를 뽑는다. recentPrompts는 정규화된 최근 입력이다. */
export function promptEvents(prompt: string, recentPrompts: string[]): MoodEvent[] {
  const normalized = normalizePrompt(prompt);
  const events: MoodEvent[] = [];
  if (normalized !== "" && recentPrompts.some((recent) => bigramSimilarity(normalized, recent) >= REPEAT_SIMILARITY)) {
    events.push({ kind: "repeatedPrompt" });
  }
  if (containsAny(normalized, PRAISE_KEYWORDS)) {
    events.push({ kind: "praise" });
  }
  if (containsAny(normalized, INSULT_KEYWORDS)) {
    events.push({ kind: "insult" });
  }
  return events;
}

function bashCommand(toolInput: unknown): string | undefined {
  if (typeof toolInput !== "object" || toolInput === null) {
    return undefined;
  }
  const { command } = toolInput as Record<string, unknown>;
  return typeof command === "string" ? command : undefined;
}

export function toolEvents(input: PostToolUseHookInput | PostToolUseFailureHookInput): MoodEvent[] {
  if (input.hook_event_name === "PostToolUseFailure") {
    return input.is_interrupt === true ? [] : [{ kind: "toolFailure" }];
  }
  const command = input.tool_name === "Bash" ? bashCommand(input.tool_input) : undefined;
  if (command !== undefined && TEST_COMMAND_PATTERN.test(command)) {
    return [{ kind: "testPassed" }];
  }
  return [{ kind: "toolSuccess" }];
}

export function turnDurationEvents(durationMs: number): MoodEvent[] {
  return durationMs > SLOW_TURN_MS ? [{ kind: "slowTurn" }] : [];
}
