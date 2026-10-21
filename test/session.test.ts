import type { CanUseTool, ModelInfo, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi, type Mock } from "vitest";
import { Session, type QueryFn } from "../src/session.js";
import type { PermissionPrompter, UiEvent } from "../src/types.js";

interface FakeCall {
  options: Options;
  prompts: string[];
  interrupt: Mock<() => Promise<void>>;
  setModel: Mock<(model?: string) => Promise<void>>;
  supportedModels: Mock<() => Promise<ModelInfo[]>>;
}

const MODEL_LIST = [{ value: "opus", displayName: "Opus", description: "d" }] as ModelInfo[];

function sdkMessage(partial: Record<string, unknown>): SDKMessage {
  return { uuid: "u", session_id: "s1", parent_tool_use_id: null, ...partial } as unknown as SDKMessage;
}

function initMessage(sessionId = "s1"): SDKMessage {
  return sdkMessage({ type: "system", subtype: "init", session_id: sessionId, model: "m", apiKeySource: "ANTHROPIC_API_KEY" });
}

function resultMessage(totalCostUsd: number): SDKMessage {
  return sdkMessage({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: totalCostUsd });
}

/** 입력 하나마다 init과 누적 비용 result를 돌려주는 가짜 SDK. */
class FakeSdk {
  readonly calls: FakeCall[] = [];
  private holdResult: Promise<void> | undefined;
  private releaseResult: (() => void) | undefined;
  private throwOnNextInput: Error | undefined;

  hold(): void {
    this.holdResult = new Promise((resolve) => {
      this.releaseResult = resolve;
    });
  }

  release(): void {
    this.releaseResult?.();
    this.holdResult = undefined;
  }

  failOnNextInput(error: Error): void {
    this.throwOnNextInput = error;
  }

  readonly queryFn: QueryFn = ({ prompt, options }) => {
    const call: FakeCall = {
      options,
      prompts: [],
      interrupt: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
      supportedModels: vi.fn(async () => MODEL_LIST),
    };
    this.calls.push(call);
    const sdk = this;
    async function* run(): AsyncGenerator<SDKMessage, void> {
      let turnCount = 0;
      for await (const message of prompt) {
        call.prompts.push(String((message as SDKUserMessage).message.content));
        if (sdk.throwOnNextInput) {
          const error = sdk.throwOnNextInput;
          sdk.throwOnNextInput = undefined;
          throw error;
        }
        turnCount += 1;
        yield initMessage(options.resume ?? "s1");
        if (sdk.holdResult) {
          await sdk.holdResult;
        }
        yield resultMessage(0.01 * turnCount);
      }
    }
    return Object.assign(run(), {
      interrupt: call.interrupt,
      setModel: call.setModel,
      supportedModels: call.supportedModels,
    });
  };
}

function createSession(options: { prompter?: PermissionPrompter; resume?: string } = {}) {
  const sdk = new FakeSdk();
  const events: UiEvent[] = [];
  const session = new Session({
    queryFn: sdk.queryFn,
    baseOptions: { cwd: "/work" },
    prompter: options.prompter ?? (async () => "allow"),
    resume: options.resume,
  });
  session.onEvent((event) => events.push(event));
  return { sdk, session, events };
}

function eventsOfType<T extends UiEvent["type"]>(events: UiEvent[], type: T): Extract<UiEvent, { type: T }>[] {
  return events.filter((event): event is Extract<UiEvent, { type: T }> => event.type === type);
}

function canUseTool(call: FakeCall): CanUseTool {
  const handler = call.options.canUseTool;
  if (!handler) {
    throw new Error("canUseTool이 설정되지 않았습니다");
  }
  return handler;
}

const toolOptions = { signal: new AbortController().signal } as Parameters<CanUseTool>[2];

describe("Session", () => {
  it("send한 텍스트가 SDKUserMessage로 전달되고 baseOptions가 유지된다", async () => {
    const { sdk, session } = createSession();
    session.start();
    session.send("hello");
    await vi.waitFor(() => expect(sdk.calls[0]?.prompts).toEqual(["hello"]));
    expect(sdk.calls[0]?.options.cwd).toBe("/work");
  });

  it("공백만 있는 send는 전달하지 않는다", async () => {
    const { sdk, session, events } = createSession();
    session.start();
    session.send("   \n");
    session.send("real");
    await vi.waitFor(() => expect(eventsOfType(events, "turn_result")).toHaveLength(1));
    expect(sdk.calls[0]?.prompts).toEqual(["real"]);
  });

  it("SDK 메시지가 UiEvent로 리스너에 전달되고 sessionId가 init에서 설정", async () => {
    const { session, events } = createSession();
    session.start();
    session.send("hello");
    await vi.waitFor(() => expect(eventsOfType(events, "turn_result")).toHaveLength(1));
    expect(eventsOfType(events, "session_start")).toHaveLength(1);
    expect(session.sessionId).toBe("s1");
  });

  it("isBusy: send 후 true, turn_result 후 false", async () => {
    const { sdk, session, events } = createSession();
    sdk.hold();
    session.start();
    session.send("hello");
    expect(session.isBusy).toBe(true);
    sdk.release();
    await vi.waitFor(() => expect(eventsOfType(events, "turn_result")).toHaveLength(1));
    expect(session.isBusy).toBe(false);
  });

  it("턴 실행 중 send한 두 번째 입력은 첫 턴이 끝난 뒤 순서대로 전달된다", async () => {
    const { sdk, session, events } = createSession();
    sdk.hold();
    session.start();
    session.send("first");
    session.send("second");
    await vi.waitFor(() => expect(sdk.calls[0]?.prompts).toEqual(["first"]));
    sdk.release();
    await vi.waitFor(() => expect(eventsOfType(events, "turn_result")).toHaveLength(2));
    expect(sdk.calls[0]?.prompts).toEqual(["first", "second"]);
  });

  it("turn_result의 비용이 누적되어 totalCostUsd에 반영된다", async () => {
    const { session, events } = createSession();
    session.start();
    session.send("a");
    session.send("b");
    await vi.waitFor(() => expect(eventsOfType(events, "turn_result")).toHaveLength(2));
    // 가짜 SDK의 total_cost_usd는 누적값(0.01 → 0.02)이다.
    expect(session.totalCostUsd).toBeCloseTo(0.02);
  });

  it("interrupt: busy면 query.interrupt를 호출하고 대기 중 입력을 비운다", async () => {
    const { sdk, session, events } = createSession();
    sdk.hold();
    session.start();
    session.send("first");
    session.send("queued");
    await vi.waitFor(() => expect(sdk.calls[0]?.prompts).toEqual(["first"]));
    await session.interrupt();
    expect(sdk.calls[0]?.interrupt).toHaveBeenCalledTimes(1);
    sdk.release();
    await vi.waitFor(() => expect(eventsOfType(events, "turn_result")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sdk.calls[0]?.prompts).toEqual(["first"]);
  });

  it("interrupt: idle이면 query.interrupt를 호출하지 않는다", async () => {
    const { sdk, session } = createSession();
    session.start();
    await session.interrupt();
    expect(sdk.calls[0]?.interrupt).not.toHaveBeenCalled();
  });

  it("canUseTool: prompter가 allow → updatedInput과 함께 allow", async () => {
    const { sdk, session } = createSession({ prompter: async () => "allow" });
    session.start();
    const result = await canUseTool(sdk.calls[0]!)("Bash", { command: "ls" }, toolOptions);
    expect(result).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
  });

  it("canUseTool: deny → '사용자가 거부했습니다'", async () => {
    const { sdk, session } = createSession({ prompter: async () => "deny" });
    session.start();
    const result = await canUseTool(sdk.calls[0]!)("Bash", { command: "rm -rf x" }, toolOptions);
    expect(result).toEqual({ behavior: "deny", message: "사용자가 거부했습니다" });
  });

  it("canUseTool: always → allow, 같은 도구의 다음 요청은 prompter를 부르지 않는다", async () => {
    const prompter = vi.fn<PermissionPrompter>(async () => "always");
    const { sdk, session } = createSession({ prompter });
    session.start();
    const handler = canUseTool(sdk.calls[0]!);
    await handler("Edit", { file_path: "/a" }, toolOptions);
    const second = await handler("Edit", { file_path: "/b" }, toolOptions);
    expect(second).toEqual({ behavior: "allow", updatedInput: { file_path: "/b" } });
    expect(prompter).toHaveBeenCalledTimes(1);
  });

  it("canUseTool: prompter에 toolName, summarizeToolInput 결과, SDK signal을 넘긴다", async () => {
    const prompter = vi.fn<PermissionPrompter>(async () => "allow");
    const { sdk, session } = createSession({ prompter });
    session.start();
    await canUseTool(sdk.calls[0]!)("Bash", { command: "npm test\nmore" }, toolOptions);
    expect(prompter).toHaveBeenCalledWith({ toolName: "Bash", summary: "npm test", signal: toolOptions.signal });
  });

  it("interrupt: query.interrupt가 reject해도 던지지 않고 error 이벤트로 알린다", async () => {
    const { sdk, session, events } = createSession();
    sdk.hold();
    session.start();
    session.send("first");
    await vi.waitFor(() => expect(sdk.calls[0]?.prompts).toEqual(["first"]));
    sdk.calls[0]!.interrupt.mockRejectedValueOnce(new Error("transport closed"));

    await expect(session.interrupt()).resolves.toBeUndefined();
    expect(eventsOfType(events, "error")[0]?.message).toContain("transport closed");
  });

  it("메시지 루프가 throw → error 이벤트, sessionId로 resume해 한 번 재연결하고 누적 비용을 이어간다", async () => {
    const { sdk, session, events } = createSession();
    session.start();
    session.send("a");
    await vi.waitFor(() => expect(eventsOfType(events, "turn_result")).toHaveLength(1));
    sdk.failOnNextInput(new Error("process died"));
    session.send("b");
    await vi.waitFor(() => expect(sdk.calls).toHaveLength(2));
    expect(eventsOfType(events, "error")[0]?.message).toContain("process died");
    expect(sdk.calls[1]?.options.resume).toBe("s1");

    session.send("c");
    await vi.waitFor(() => expect(eventsOfType(events, "turn_result")).toHaveLength(2));
    expect(eventsOfType(events, "turn_result")[1]?.totalCostUsd).toBeCloseTo(0.02);
  });

  it("재연결 시 대기 중이던 입력은 취소되고 그 사실을 error 이벤트로 알린다", async () => {
    const { sdk, session, events } = createSession({ resume: "s1" });
    session.start();
    sdk.failOnNextInput(new Error("process died"));
    session.send("a");
    session.send("queued");
    await vi.waitFor(() => expect(sdk.calls).toHaveLength(2));
    expect(eventsOfType(events, "error").some((event) => event.message.includes("대기 중 입력이 취소되었습니다"))).toBe(true);
    expect(session.isBusy).toBe(false);
  });

  it("재연결 후 다시 throw → error 이벤트와 session_closed, 재시도 없음", async () => {
    const { sdk, session, events } = createSession({ resume: "s1" });
    session.start();
    sdk.failOnNextInput(new Error("first"));
    session.send("a");
    await vi.waitFor(() => expect(sdk.calls).toHaveLength(2));
    sdk.failOnNextInput(new Error("second"));
    session.send("b");
    await vi.waitFor(() => expect(eventsOfType(events, "session_closed")).toHaveLength(1));
    expect(sdk.calls).toHaveLength(2);
    expect(eventsOfType(events, "error")).toHaveLength(2);
  });

  it("sessionId를 모르는 상태에서 throw → 재연결 없이 session_closed", async () => {
    const { sdk, session, events } = createSession();
    session.start();
    sdk.failOnNextInput(new Error("boom"));
    session.send("a");
    await vi.waitFor(() => expect(eventsOfType(events, "session_closed")).toHaveLength(1));
    expect(sdk.calls).toHaveLength(1);
  });

  it("close → session_closed(sessionId, totalCostUsd)를 한 번만 낸다", async () => {
    const { session, events } = createSession();
    session.start();
    session.send("a");
    await vi.waitFor(() => expect(eventsOfType(events, "turn_result")).toHaveLength(1));
    await session.close();
    await session.close();
    expect(eventsOfType(events, "session_closed")).toEqual([{ type: "session_closed", sessionId: "s1", totalCostUsd: 0.01 }]);
  });

  it("setModel: 현재 query에 전달하고 currentModel을 갱신한다", async () => {
    const { sdk, session } = createSession();
    session.start();
    await session.setModel("x");
    expect(sdk.calls[0]?.setModel).toHaveBeenCalledWith("x");
    expect(session.currentModel).toBe("x");
  });

  it("currentModel: baseOptions.model로 시작하고 init의 model로 갱신된다", async () => {
    const sdk = new FakeSdk();
    const session = new Session({ queryFn: sdk.queryFn, baseOptions: { model: "base" }, prompter: async () => "allow" });
    expect(session.currentModel).toBe("base");
    session.start();
    session.send("a");
    await vi.waitFor(() => expect(session.currentModel).toBe("m"));
  });

  it("listModels: query의 supportedModels 결과를 그대로 돌려주고 busy여도 된다", async () => {
    const { sdk, session } = createSession();
    sdk.hold();
    session.start();
    session.send("a");
    await expect(session.listModels()).resolves.toBe(MODEL_LIST);
    sdk.release();
  });

  it("replace(): 새 query를 resume 없이 열고 이후 send는 새 query로 가며 비용이 0으로 시작한다", async () => {
    const { sdk, session, events } = createSession();
    session.start();
    session.send("a");
    await vi.waitFor(() => expect(eventsOfType(events, "turn_result")).toHaveLength(1));
    await session.replace();
    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[1]?.options.resume).toBeUndefined();
    expect(session.totalCostUsd).toBe(0);
    session.send("b");
    await vi.waitFor(() => expect(sdk.calls[1]?.prompts).toEqual(["b"]));
    expect(sdk.calls[0]?.prompts).toEqual(["a"]);
    expect(eventsOfType(events, "session_closed")).toHaveLength(0);
  });

  it("replace(resume): options.resume과 sessionId가 그 값이 된다", async () => {
    const { sdk, session } = createSession();
    session.start();
    await session.replace("abc");
    expect(sdk.calls[1]?.options.resume).toBe("abc");
    expect(session.sessionId).toBe("abc");
  });

  it("replace 후 이전 query의 루프 종료는 error 이벤트나 재연결을 일으키지 않는다", async () => {
    const { sdk, session, events } = createSession();
    session.start();
    session.send("a");
    await vi.waitFor(() => expect(eventsOfType(events, "turn_result")).toHaveLength(1));
    await session.replace();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sdk.calls).toHaveLength(2);
    expect(eventsOfType(events, "error")).toHaveLength(0);
    expect(eventsOfType(events, "session_closed")).toHaveLength(0);
  });

  it("busy 중 setModel/replace는 안내 메시지로 reject한다", async () => {
    const { sdk, session } = createSession();
    sdk.hold();
    session.start();
    session.send("a");
    await expect(session.setModel("x")).rejects.toThrow("턴이 끝난 뒤 다시 입력해 주세요");
    await expect(session.replace()).rejects.toThrow("턴이 끝난 뒤 다시 입력해 주세요");
    sdk.release();
  });

  it("setModel로 바꾼 모델은 replace 후 새 query의 options.model로 유지된다", async () => {
    const { sdk, session } = createSession();
    session.start();
    await session.setModel("x");
    await session.replace();
    expect(sdk.calls[1]?.options.model).toBe("x");
  });

  it("replace 후에도 세션 동안 항상 허용한 도구는 prompter 없이 허용된다", async () => {
    const prompter = vi.fn<PermissionPrompter>(async () => "always");
    const { sdk, session } = createSession({ prompter });
    session.start();
    await canUseTool(sdk.calls[0]!)("Edit", { file_path: "/a" }, toolOptions);
    await session.replace();
    await canUseTool(sdk.calls[1]!)("Edit", { file_path: "/b" }, toolOptions);
    expect(prompter).toHaveBeenCalledTimes(1);
  });
});
