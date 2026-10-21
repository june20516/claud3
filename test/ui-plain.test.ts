import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createPlainUi, formatEvent, parseDecision } from "../src/ui/plain.js";

describe("parseDecision", () => {
  it("y/yes는 allow, n/no는 deny, a/always는 always (대소문자 무시)", () => {
    expect(parseDecision("y")).toBe("allow");
    expect(parseDecision("YES")).toBe("allow");
    expect(parseDecision("n")).toBe("deny");
    expect(parseDecision("No")).toBe("deny");
    expect(parseDecision("a")).toBe("always");
    expect(parseDecision(" always ")).toBe("always");
  });

  it("그 밖의 답은 undefined", () => {
    expect(parseDecision("")).toBeUndefined();
    expect(parseDecision("maybe")).toBeUndefined();
  });
});

describe("formatEvent", () => {
  it("session_start는 API key 출처, Agent SDK, 모델을 표시", () => {
    const text = formatEvent({ type: "session_start", sessionId: "s1", model: "claude-haiku-5-5", apiKeySource: "ANTHROPIC_API_KEY" });
    expect(text).toContain("claud3 · API key(ANTHROPIC_API_KEY) · Agent SDK · claude-haiku-5-5");
  });

  it("text_delta는 그대로", () => {
    expect(formatEvent({ type: "text_delta", text: "안녕" })).toBe("안녕");
  });

  it("tool_start는 '⏺ Bash(npm test)' 포함", () => {
    expect(formatEvent({ type: "tool_start", toolUseId: "t1", name: "Bash", summary: "npm test" })).toContain("⏺ Bash(npm test)");
  });

  it("성공한 tool_end는 빈 문자열", () => {
    expect(formatEvent({ type: "tool_end", toolUseId: "t1", isError: false, summary: "ok" })).toBe("");
  });

  it("실패한 tool_end는 '⎿ <summary>' 포함", () => {
    expect(formatEvent({ type: "tool_end", toolUseId: "t1", isError: true, summary: "not found" })).toContain("⎿ not found");
  });

  it("turn_result는 '$0.0012 · 누적 $0.0100' 포함", () => {
    expect(formatEvent({ type: "turn_result", costUsd: 0.0012, totalCostUsd: 0.01, isError: false })).toContain("$0.0012 · 누적 $0.0100");
  });

  it("credit balance 오류면 오류 메시지와 크레딧 소진 안내 포함", () => {
    const text = formatEvent({
      type: "turn_result",
      costUsd: 0,
      totalCostUsd: 0,
      isError: true,
      errorMessage: "API Error: Your Credit Balance is too low",
    });
    expect(text).toContain("API Error: Your Credit Balance is too low");
    expect(text).toContain("프로모션 크레딧이 소진되었거나 만료되었을 수 있습니다 (Console › Billing 확인)");
  });

  it("다른 오류에는 크레딧 안내가 없다", () => {
    const text = formatEvent({ type: "turn_result", costUsd: 0, totalCostUsd: 0, isError: true, errorMessage: "boom" });
    expect(text).toContain("boom");
    expect(text).not.toContain("프로모션 크레딧");
  });

  it("session_closed는 'claud3 --resume <id>'와 누적 비용 포함", () => {
    const text = formatEvent({ type: "session_closed", sessionId: "abc", totalCostUsd: 0.5 });
    expect(text).toContain("claud3 --resume abc");
    expect(text).toContain("누적 비용 $0.5000");
  });
});

function createTestUi() {
  const input = new PassThrough();
  const output = new PassThrough();
  const state = { written: "" };
  output.on("data", (chunk: Buffer) => {
    state.written += chunk.toString();
  });
  const ui = createPlainUi({ input, output });
  const questionCount = (): number => state.written.split("허용할까요?").length - 1;
  return { input, state, ui, questionCount };
}

describe("createPlainUi prompter", () => {
  it("동시에 온 권한 요청 두 개를 차례로 묻고 각각의 답을 돌려준다", async () => {
    const { input, ui, questionCount } = createTestUi();

    const first = ui.prompter({ toolName: "WebFetch", summary: "a" });
    const second = ui.prompter({ toolName: "WebFetch", summary: "b" });
    await vi.waitFor(() => expect(questionCount()).toBe(1));
    input.write("y\n");
    await expect(first).resolves.toBe("allow");

    await vi.waitFor(() => expect(questionCount()).toBe(2));
    input.write("n\n");
    await expect(second).resolves.toBe("deny");
  });

  it("SDK가 signal로 요청을 취소하면 질문을 닫고 deny를 돌려준다", async () => {
    const { ui, questionCount } = createTestUi();
    const controller = new AbortController();

    const decision = ui.prompter({ toolName: "Bash", summary: "ls", signal: controller.signal });
    await vi.waitFor(() => expect(questionCount()).toBe(1));
    controller.abort();

    await expect(decision).resolves.toBe("deny");
  });

  it("이미 취소된 요청은 묻지 않고 deny를 돌려준다", async () => {
    const { ui, questionCount } = createTestUi();
    const controller = new AbortController();
    controller.abort();

    await expect(ui.prompter({ toolName: "Bash", summary: "ls", signal: controller.signal })).resolves.toBe("deny");
    expect(questionCount()).toBe(0);
  });

  it("잘못된 답 'x' 후 'y' → 다시 묻고 allow", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString();
    });
    const ui = createPlainUi({ input, output });

    const decision = ui.prompter({ toolName: "Bash", summary: "ls" });
    await vi.waitFor(() => expect(written).toContain("Bash(ls) 허용할까요? [y]이번만 [n]거부 [a]세션 동안 항상 › "));
    input.write("x\n");
    await vi.waitFor(() => expect(written.split("허용할까요?").length - 1).toBe(2));
    input.write("y\n");

    await expect(decision).resolves.toBe("allow");
  });
});
