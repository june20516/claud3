import type { PostToolUseFailureHookInput, PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  bigramSimilarity,
  normalizePrompt,
  promptEvents,
  toolEvents,
  turnDurationEvents,
} from "../src/persona/turnEvents.js";

const BASE = { session_id: "s", transcript_path: "/tmp/t", cwd: "/tmp" };

function success(toolName: string, toolInput: unknown): PostToolUseHookInput {
  return { ...BASE, hook_event_name: "PostToolUse", tool_name: toolName, tool_input: toolInput, tool_response: {}, tool_use_id: "u" };
}

function failure(extra: Partial<PostToolUseFailureHookInput> = {}): PostToolUseFailureHookInput {
  return { ...BASE, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: {}, tool_use_id: "u", error: "x", ...extra };
}

describe("normalizePrompt", () => {
  it("소문자로 바꾸고 공백을 정리하고 행동 줄을 뺀다", () => {
    expect(normalizePrompt("  Fix   THIS\n(츄르를 준다)\n")).toBe("fix this");
  });
});

describe("bigramSimilarity", () => {
  it("거의 같은 문장은 0.8 이상, 다른 문장은 미만", () => {
    expect(bigramSimilarity("테스트 고쳐줘", "테스트 고쳐줘!")).toBeGreaterThanOrEqual(0.8);
    expect(bigramSimilarity("테스트 고쳐줘", "점심 뭐 먹지")).toBeLessThan(0.8);
  });
});

describe("promptEvents", () => {
  it("최근 입력과 거의 같으면 repeatedPrompt", () => {
    expect(promptEvents("테스트 고쳐줘!", ["테스트 고쳐줘"])).toEqual([{ kind: "repeatedPrompt" }]);
    expect(promptEvents("점심 뭐 먹지", ["테스트 고쳐줘"])).toEqual([]);
  });

  it("칭찬과 욕 키워드", () => {
    expect(promptEvents("잘했어 고마워", [])).toEqual([{ kind: "praise" }]);
    expect(promptEvents("이 멍청한 코드", [])).toEqual([{ kind: "insult" }]);
  });
});

describe("toolEvents", () => {
  it("실패는 toolFailure, 사용자 중단은 무시", () => {
    expect(toolEvents(failure())).toEqual([{ kind: "toolFailure" }]);
    expect(toolEvents(failure({ is_interrupt: true }))).toEqual([]);
  });

  it("테스트 명령 성공은 testPassed, 그 밖의 성공은 toolSuccess", () => {
    expect(toolEvents(success("Bash", { command: "npm test -- foo" }))).toEqual([{ kind: "testPassed" }]);
    expect(toolEvents(success("Bash", { command: "ls" }))).toEqual([{ kind: "toolSuccess" }]);
    expect(toolEvents(success("Read", { file_path: "/a" }))).toEqual([{ kind: "toolSuccess" }]);
  });
});

describe("turnDurationEvents", () => {
  it("60초를 넘으면 slowTurn", () => {
    expect(turnDurationEvents(61_000)).toEqual([{ kind: "slowTurn" }]);
    expect(turnDurationEvents(60_000)).toEqual([]);
  });
});
