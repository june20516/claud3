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
    expect(events).toEqual([{ type: "text_delta", text: "hi" }]);
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
