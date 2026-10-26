import { readFileSync } from "node:fs";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { createEventMapper, summarizeToolInput } from "../src/events.js";
import type { UiEvent } from "../src/types.js";

function loadFixture(name: string): SDKMessage[] {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as SDKMessage[];
}

// 테스트용으로 필요한 필드만 채운 SDK 메시지를 만든다.
function sdkMessage(partial: Record<string, unknown>): SDKMessage {
  return { uuid: "u", session_id: "s1", parent_tool_use_id: null, ...partial } as unknown as SDKMessage;
}

function resultMessage(totalCostUsd: number, extra: Record<string, unknown> = {}): SDKMessage {
  return sdkMessage({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: totalCostUsd, ...extra });
}

function mapAll(messages: SDKMessage[], initialTotalUsd?: number): UiEvent[] {
  const map = createEventMapper(initialTotalUsd);
  return messages.flatMap((message) => map(message));
}

describe("summarizeToolInput", () => {
  it("AskUserQuestion은 질문 수와 첫 질문을 보인다", () => {
    const questions = [{ question: "어떤 방식으로 할까요?" }, { question: "둘째?" }];
    expect(summarizeToolInput("AskUserQuestion", { questions })).toBe("질문 2개: 어떤 방식으로 할까요?");
    expect(summarizeToolInput("AskUserQuestion", { questions: [questions[0]] })).toBe("어떤 방식으로 할까요?");
  });

  it("Bash는 command 첫 줄", () => {
    expect(summarizeToolInput("Bash", { command: "npm test\necho hi" })).toBe("npm test");
  });

  it("Read/Edit/Write는 file_path", () => {
    expect(summarizeToolInput("Edit", { file_path: "/a/b.ts", old_string: "x" })).toBe("/a/b.ts");
    expect(summarizeToolInput("Read", { file_path: "/a/c.ts" })).toBe("/a/c.ts");
    expect(summarizeToolInput("Write", { file_path: "/a/d.ts", content: "x" })).toBe("/a/d.ts");
  });

  it("Grep/Glob은 pattern", () => {
    expect(summarizeToolInput("Grep", { pattern: "foo" })).toBe("foo");
    expect(summarizeToolInput("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
  });

  it("그 밖은 JSON, 80자에서 자르고 …", () => {
    const summary = summarizeToolInput("Other", { v: "x".repeat(200) });
    expect(summary.length).toBe(80);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("긴 Bash 명령도 80자에서 자른다", () => {
    const summary = summarizeToolInput("Bash", { command: "y".repeat(100) });
    expect(summary).toBe(`${"y".repeat(79)}…`);
  });
});

describe("createEventMapper", () => {
  it("fixture turn1: session_start 1개, text_delta 합이 'one', turn_result 1개", () => {
    const events = mapAll(loadFixture("probe-turn1.json"));

    const starts = events.filter((event) => event.type === "session_start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ model: "claude-haiku-5-5", apiKeySource: "ANTHROPIC_API_KEY" });

    const text = events.flatMap((event) => (event.type === "text_delta" ? [event.text] : [])).join("");
    expect(text).toBe("one");

    expect(events.filter((event) => event.type === "turn_result")).toHaveLength(1);
  });

  it("매 턴 다시 오는 init은 session_start를 다시 내지 않는다", () => {
    const events = mapAll([...loadFixture("probe-turn1.json"), ...loadFixture("probe-turn2.json")]);
    expect(events.filter((event) => event.type === "session_start")).toHaveLength(1);
  });

  it("stream_event의 text_delta만 text_delta로, assistant 메시지의 text는 무시", () => {
    const events = mapAll([
      sdkMessage({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } }),
      sdkMessage({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
    ]);
    expect(events.filter((event) => event.type !== "token_usage")).toEqual([{ type: "text_delta", text: "hi" }]);
  });

  describe("token_usage", () => {
    const streamEvent = (event: Record<string, unknown>) => sdkMessage({ type: "stream_event", event });
    const messageStart = (input: number, cacheRead = 0, cacheCreation = 0) =>
      streamEvent({
        type: "message_start",
        message: {
          usage: {
            input_tokens: input,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheCreation,
            output_tokens: 1,
          },
        },
      });
    const textDelta = (text: string) =>
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
    const messageDelta = (output: number) => streamEvent({ type: "message_delta", delta: {}, usage: { output_tokens: output } });
    const usages = (events: UiEvent[]) => events.filter((event) => event.type === "token_usage");

    it("message_start의 입력 토큰(캐시 포함)을 보낸 토큰으로 알린다", () => {
      expect(usages(mapAll([messageStart(100, 2000, 300)]))).toEqual([
        { type: "token_usage", inputTokens: 2400, outputTokens: 0 },
      ]);
    });

    it("응답 조각이 오는 동안 받은 토큰을 글자 수로 추정해 늘리고, message_delta가 오면 정확한 값으로 바꾼다", () => {
      const events = mapAll([messageStart(10), textDelta("a".repeat(8)), textDelta("b".repeat(4)), messageDelta(5)]);

      expect(usages(events).map((event) => event.outputTokens)).toEqual([0, 2, 3, 5]);
    });

    it("도구 입력·생각 조각도 받은 토큰으로 센다", () => {
      const events = mapAll([
        messageStart(10),
        streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "x".repeat(8) } }),
        streamEvent({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "y".repeat(4) } }),
      ]);

      expect(usages(events).map((event) => event.outputTokens)).toEqual([0, 2, 3]);
    });

    it("한 턴의 여러 API 호출은 더하고, 턴이 끝나면 0부터 다시 센다", () => {
      const events = mapAll([
        messageStart(100),
        messageDelta(20),
        messageStart(150),
        messageDelta(30),
        resultMessage(0.01),
        messageStart(70),
      ]);

      expect(usages(events)).toEqual([
        { type: "token_usage", inputTokens: 100, outputTokens: 0 },
        { type: "token_usage", inputTokens: 100, outputTokens: 20 },
        { type: "token_usage", inputTokens: 250, outputTokens: 20 },
        { type: "token_usage", inputTokens: 250, outputTokens: 50 },
        { type: "token_usage", inputTokens: 70, outputTokens: 0 },
      ]);
    });
  });

  it("assistant의 tool_use → tool_start(name, summary, input)", () => {
    const events = mapAll([
      sdkMessage({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } }] },
      }),
    ]);
    expect(events).toEqual([{ type: "tool_start", toolUseId: "t1", name: "Bash", summary: "ls -la", input: { command: "ls -la" } }]);
  });

  it("user의 tool_result → tool_end(isError, 내용 첫 줄 80자)", () => {
    const events = mapAll([
      sdkMessage({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", is_error: true, content: `${"e".repeat(100)}\nsecond line` },
            { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "done\nmore" }] },
          ],
        },
      }),
    ]);
    expect(events).toEqual([
      { type: "tool_end", toolUseId: "t1", isError: true, summary: `${"e".repeat(79)}…` },
      { type: "tool_end", toolUseId: "t2", isError: false, summary: "done" },
    ]);
  });

  it("두 턴 연속: turn_result.costUsd는 턴 비용, totalCostUsd는 누적 (total_cost_usd는 누적값)", () => {
    const events = mapAll([resultMessage(0.002), resultMessage(0.005)]);
    const results = events.filter((event) => event.type === "turn_result");
    expect(results[0]).toMatchObject({ costUsd: 0.002, totalCostUsd: 0.002 });
    expect(results[1].costUsd).toBeCloseTo(0.003);
    expect(results[1].totalCostUsd).toBeCloseTo(0.005);
  });

  it("initialTotalUsd=1.5면 첫 turn_result.totalCostUsd = 1.5 + 턴 비용", () => {
    const events = mapAll([resultMessage(0.25)], 1.5);
    expect(events).toEqual([{ type: "turn_result", costUsd: 0.25, totalCostUsd: 1.75, isError: false }]);
  });

  it("success인데 is_error면 errorMessage = result", () => {
    const events = mapAll([resultMessage(0, { is_error: true, result: "API Error: credit balance is too low" })]);
    expect(events[0]).toMatchObject({ type: "turn_result", isError: true, errorMessage: "API Error: credit balance is too low" });
  });

  it("subtype이 오류면 errors를 줄바꿈으로 합치고, 없으면 subtype", () => {
    const events = mapAll([
      resultMessage(0, { subtype: "error_during_execution", is_error: true, errors: ["a", "b"] }),
      resultMessage(0, { subtype: "error_max_turns", is_error: true, errors: [] }),
    ]);
    expect(events[0]).toMatchObject({ isError: true, errorMessage: "a\nb" });
    expect(events[1]).toMatchObject({ isError: true, errorMessage: "error_max_turns" });
  });
});
