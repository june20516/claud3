import type { CanUseTool, ModelInfo, Options, PermissionMode, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi, type Mock } from "vitest";
import { Session, type QueryFn } from "../src/session.js";
import type { PermissionPrompter, UiEvent, UserQuestionPrompter } from "../src/types.js";

interface FakeCall {
  options: Options;
  prompts: string[];
  interrupt: Mock<() => Promise<void>>;
  setModel: Mock<(model?: string) => Promise<void>>;
  supportedModels: Mock<() => Promise<ModelInfo[]>>;
  setPermissionMode: Mock<(mode: PermissionMode) => Promise<void>>;
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
      setPermissionMode: vi.fn(async () => {}),
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
      setPermissionMode: call.setPermissionMode,
    });
  };
}

function createSession(
  options: {
    prompter?: PermissionPrompter;
    resume?: string;
    permissionMode?: PermissionMode;
    loadHistory?: (sessionId: string) => Promise<string[]>;
    askUser?: UserQuestionPrompter;
  } = {},
) {
  const sdk = new FakeSdk();
  const events: UiEvent[] = [];
  const session = new Session({
    queryFn: sdk.queryFn,
    baseOptions: { cwd: "/work", ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }) },
    prompter: options.prompter ?? (async () => "allow"),
    resume: options.resume,
    ...(options.loadHistory === undefined ? {} : { loadHistory: options.loadHistory }),
    ...(options.askUser === undefined ? {} : { askUser: options.askUser }),
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

  describe("ExitPlanMode 계획 승인", () => {
    const planInput = { plan: "1. 고친다", planFilePath: "/tmp/plan.md" };

    it("prompter 요청에 plan.text·plan.filePath를 담는다", async () => {
      const prompter = vi.fn<PermissionPrompter>(async () => "allow");
      const { sdk, session } = createSession({ prompter });
      session.start();
      await canUseTool(sdk.calls[0]!)("ExitPlanMode", planInput, toolOptions);
      expect(prompter.mock.calls[0]![0].plan).toEqual({ text: "1. 고친다", filePath: "/tmp/plan.md" });
    });

    it("입력에 필드가 없으면 plan은 빈 객체", async () => {
      const prompter = vi.fn<PermissionPrompter>(async () => "allow");
      const { sdk, session } = createSession({ prompter });
      session.start();
      await canUseTool(sdk.calls[0]!)("ExitPlanMode", {}, toolOptions);
      expect(prompter.mock.calls[0]![0].plan).toEqual({});
    });

    it("다른 도구의 요청에는 plan이 없다", async () => {
      const prompter = vi.fn<PermissionPrompter>(async () => "allow");
      const { sdk, session } = createSession({ prompter });
      session.start();
      await canUseTool(sdk.calls[0]!)("Bash", { command: "ls" }, toolOptions);
      expect(prompter.mock.calls[0]![0]).not.toHaveProperty("plan");
    });

    it("allow → updatedInput만 포함한 allow", async () => {
      const { sdk, session } = createSession({ prompter: async () => "allow" });
      session.start();
      const result = await canUseTool(sdk.calls[0]!)("ExitPlanMode", planInput, toolOptions);
      expect(result).toEqual({ behavior: "allow", updatedInput: planInput });
    });

    it("allowAcceptEdits → acceptEdits 모드 전환을 updatedPermissions로 요청", async () => {
      const { sdk, session } = createSession({ prompter: async () => "allowAcceptEdits" });
      session.start();
      const result = await canUseTool(sdk.calls[0]!)("ExitPlanMode", planInput, toolOptions);
      expect(result).toEqual({
        behavior: "allow",
        updatedInput: planInput,
        updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
      });
    });

    it("deny → 계획을 다듬으라는 메시지", async () => {
      const { sdk, session } = createSession({ prompter: async () => "deny" });
      session.start();
      const result = await canUseTool(sdk.calls[0]!)("ExitPlanMode", planInput, toolOptions);
      expect(result).toEqual({
        behavior: "deny",
        message: "사용자가 계획을 승인하지 않았습니다. 계획을 계속 다듬어 주세요",
      });
    });

    it("always가 와도 ExitPlanMode는 항상 허용 목록에 넣지 않는다", async () => {
      const prompter = vi.fn<PermissionPrompter>(async () => "always");
      const { sdk, session } = createSession({ prompter });
      session.start();
      const handler = canUseTool(sdk.calls[0]!);
      await handler("ExitPlanMode", planInput, toolOptions);
      await handler("ExitPlanMode", planInput, toolOptions);
      expect(prompter).toHaveBeenCalledTimes(2);
    });

    it("다른 도구가 allowAcceptEdits를 받으면 일반 allow로 취급", async () => {
      const { sdk, session } = createSession({ prompter: async () => "allowAcceptEdits" });
      session.start();
      const result = await canUseTool(sdk.calls[0]!)("Bash", { command: "ls" }, toolOptions);
      expect(result).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    });
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

  describe("AskUserQuestion", () => {
    const questionInput = {
      questions: [
        {
          question: "어떤 방식으로 할까요?",
          header: "방식",
          multiSelect: false,
          options: [
            { label: "A안", description: "빠름" },
            { label: "B안", description: "안전함" },
          ],
        },
      ],
    };

    it("권한 질문 대신 askUser로 묻고, 답을 updatedInput.answers로 돌려준다", async () => {
      const prompter = vi.fn<PermissionPrompter>(async () => "allow");
      const askUser = vi.fn<UserQuestionPrompter>(async () => ({ "어떤 방식으로 할까요?": "B안" }));
      const { sdk, session } = createSession({ prompter, askUser });
      session.start();
      await vi.waitFor(() => expect(sdk.calls).toHaveLength(1));

      const result = await canUseTool(sdk.calls[0]!)("AskUserQuestion", questionInput, toolOptions);

      expect(result).toEqual({
        behavior: "allow",
        updatedInput: { ...questionInput, answers: { "어떤 방식으로 할까요?": "B안" } },
      });
      expect(askUser).toHaveBeenCalledWith({ questions: questionInput.questions, signal: toolOptions.signal });
      expect(prompter).not.toHaveBeenCalled();
    });

    it("사용자가 답하지 않으면 거부한다", async () => {
      const { sdk, session } = createSession({ askUser: async () => undefined });
      session.start();
      await vi.waitFor(() => expect(sdk.calls).toHaveLength(1));

      const result = await canUseTool(sdk.calls[0]!)("AskUserQuestion", questionInput, toolOptions);

      expect(result).toEqual({ behavior: "deny", message: "사용자가 질문에 답하지 않았습니다" });
    });

    it("질문 형식을 읽지 못하면 묻지 않고 거부한다", async () => {
      const askUser = vi.fn<UserQuestionPrompter>(async () => ({}));
      const { sdk, session } = createSession({ askUser });
      session.start();
      await vi.waitFor(() => expect(sdk.calls).toHaveLength(1));

      const result = await canUseTool(sdk.calls[0]!)("AskUserQuestion", { questions: "x" }, toolOptions);

      expect(result).toEqual({ behavior: "deny", message: "질문 형식을 읽지 못했습니다" });
      expect(askUser).not.toHaveBeenCalled();
    });

    it("askUser가 없으면 거부한다", async () => {
      const { sdk, session } = createSession();
      session.start();
      await vi.waitFor(() => expect(sdk.calls).toHaveLength(1));

      const result = await canUseTool(sdk.calls[0]!)("AskUserQuestion", questionInput, toolOptions);

      expect(result).toEqual({ behavior: "deny", message: "이 화면에서는 질문에 답할 수 없습니다" });
    });
  });

  describe("이전 대화 불러오기", () => {
    it("resume으로 시작하면 이전 대화를 SDK 이벤트보다 먼저 history 이벤트로 보낸다", async () => {
      const loadHistory = vi.fn(async () => ["> 이전 입력", "", "이전 응답"]);
      const { session, events } = createSession({ resume: "old", loadHistory });
      session.start();
      session.send("a");
      await vi.waitFor(() => expect(eventsOfType(events, "turn_result")).toHaveLength(1));

      expect(loadHistory).toHaveBeenCalledWith("old");
      expect(events[0]).toEqual({ type: "history", lines: ["> 이전 입력", "", "이전 응답"] });
      expect(eventsOfType(events, "history")).toHaveLength(1);
    });

    it("resume 없이 시작하거나 replace()로 새 대화를 열면 불러오지 않는다", async () => {
      const loadHistory = vi.fn(async () => ["x"]);
      const { session, events } = createSession({ loadHistory });
      session.start();
      await session.replace();
      session.send("a");
      await vi.waitFor(() => expect(eventsOfType(events, "turn_result")).toHaveLength(1));

      expect(loadHistory).not.toHaveBeenCalled();
      expect(eventsOfType(events, "history")).toHaveLength(0);
    });

    it("replace(resume)로 세션을 옮기면 그 세션의 이전 대화를 보낸다", async () => {
      const loadHistory = vi.fn(async (sessionId: string) => [`${sessionId}의 기록`]);
      const { session, events } = createSession({ loadHistory });
      session.start();
      await session.replace("other");

      await vi.waitFor(() => expect(eventsOfType(events, "history")).toEqual([{ type: "history", lines: ["other의 기록"] }]));
    });

    it("기록이 비어 있으면 history 이벤트를 보내지 않는다", async () => {
      const { session, events } = createSession({ resume: "old", loadHistory: async () => [] });
      session.start();
      session.send("a");
      await vi.waitFor(() => expect(eventsOfType(events, "turn_result")).toHaveLength(1));

      expect(eventsOfType(events, "history")).toHaveLength(0);
    });

    it("불러오기에 실패하면 error 이벤트로 알리고 대화는 계속한다", async () => {
      const { session, events } = createSession({
        resume: "old",
        loadHistory: async () => {
          throw new Error("파일 없음");
        },
      });
      session.start();
      session.send("a");
      await vi.waitFor(() => expect(eventsOfType(events, "turn_result")).toHaveLength(1));

      expect(eventsOfType(events, "error")).toEqual([{ type: "error", message: "이전 대화를 불러오지 못했습니다: 파일 없음" }]);
    });

    it("연결이 끊겨 다시 붙을 때는 다시 불러오지 않는다", async () => {
      const loadHistory = vi.fn(async () => ["이전"]);
      const { sdk, session, events } = createSession({ resume: "old", loadHistory });
      session.start();
      session.send("a");
      await vi.waitFor(() => expect(eventsOfType(events, "turn_result")).toHaveLength(1));
      sdk.failOnNextInput(new Error("끊김"));
      session.send("b");
      await vi.waitFor(() => expect(sdk.calls).toHaveLength(2));
      session.send("c");
      await vi.waitFor(() => expect(eventsOfType(events, "turn_result")).toHaveLength(2));

      expect(loadHistory).toHaveBeenCalledTimes(1);
      expect(eventsOfType(events, "history")).toHaveLength(1);
    });
  });

  describe("권한 모드", () => {
    interface Deferred {
      promise: Promise<void>;
      resolve: () => void;
      reject: (error: Error) => void;
    }

    function deferred(): Deferred {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    function modeEvents(events: UiEvent[]): PermissionMode[] {
      return eventsOfType(events, "permission_mode").map((event) => event.mode);
    }

    /** 외부에서 SDK 메시지를 흘려 넣을 수 있는 query를 가진 세션. */
    function createInjectableSession(permissionMode?: PermissionMode) {
      const events: UiEvent[] = [];
      const queue: SDKMessage[] = [];
      let wake: (() => void) | undefined;
      const calls: FakeCall[] = [];
      const session = new Session({
        queryFn: ({ options }) => {
          const call: FakeCall = {
            options,
            prompts: [],
            interrupt: vi.fn(async () => {}),
            setModel: vi.fn(async () => {}),
            supportedModels: vi.fn(async () => MODEL_LIST),
            setPermissionMode: vi.fn(async () => {}),
          };
          calls.push(call);
          async function* run(): AsyncGenerator<SDKMessage, void> {
            for (;;) {
              const next = queue.shift();
              if (next) {
                yield next;
              } else {
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
              }
            }
          }
          return Object.assign(run(), {
            interrupt: call.interrupt,
            setModel: call.setModel,
            supportedModels: call.supportedModels,
            setPermissionMode: call.setPermissionMode,
          });
        },
        baseOptions: { cwd: "/work", ...(permissionMode === undefined ? {} : { permissionMode }) },
        prompter: async () => "allow",
      });
      session.onEvent((event) => events.push(event));
      const push = (message: SDKMessage) => {
        queue.push(message);
        wake?.();
      };
      return { session, events, calls, push };
    }

    const initWith = (mode: PermissionMode) => sdkMessage({ type: "system", subtype: "init", model: "m", apiKeySource: "k", permissionMode: mode });
    const statusWith = (mode: PermissionMode) => sdkMessage({ type: "system", subtype: "status", status: null, permissionMode: mode });

    it("baseOptions의 시작값이 현재 값과 첫 query options에 반영된다", () => {
      const { sdk, session } = createSession({ permissionMode: "plan" });
      session.start();
      expect(session.currentPermissionMode).toBe("plan");
      expect(sdk.calls[0]?.options.permissionMode).toBe("plan");
    });

    it("옵션이 없으면 undefined이고 options에 키가 없다", () => {
      const { sdk, session } = createSession();
      session.start();
      expect(session.currentPermissionMode).toBeUndefined();
      expect("permissionMode" in (sdk.calls[0]?.options ?? {})).toBe(false);
    });

    it("init과 status의 permissionMode를 반영하고 바뀔 때만 이벤트를 낸다", async () => {
      const { session, events, push } = createInjectableSession();
      session.start();
      push(initWith("default"));
      await vi.waitFor(() => expect(session.currentPermissionMode).toBe("default"));
      expect(modeEvents(events)).toEqual([]);
      push(statusWith("acceptEdits"));
      await vi.waitFor(() => expect(session.currentPermissionMode).toBe("acceptEdits"));
      expect(modeEvents(events)).toEqual(["acceptEdits"]);
      push(initWith("acceptEdits"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(modeEvents(events)).toEqual(["acceptEdits"]);
    });

    it("setPermissionMode는 await 전에 값과 이벤트를 바꾸고 SDK를 호출한다 (busy여도)", async () => {
      const { sdk, session, events } = createSession({ permissionMode: "default" });
      sdk.hold();
      session.start();
      session.send("a");
      const pending = session.setPermissionMode("plan");
      expect(session.currentPermissionMode).toBe("plan");
      expect(modeEvents(events)).toEqual(["plan"]);
      expect(sdk.calls[0]?.setPermissionMode).toHaveBeenCalledWith("plan");
      await pending;
      sdk.release();
    });

    it("같은 모드면 SDK 호출과 이벤트가 없다", async () => {
      const { sdk, session, events } = createSession({ permissionMode: "plan" });
      session.start();
      await session.setPermissionMode("plan");
      expect(sdk.calls[0]?.setPermissionMode).not.toHaveBeenCalled();
      expect(modeEvents(events)).toEqual([]);
    });

    it("SDK 실패 시 이전 값으로 되돌리고 permission_mode, error 순으로 알리며 resolve한다", async () => {
      const { sdk, session, events } = createSession({ permissionMode: "default" });
      session.start();
      sdk.calls[0]?.setPermissionMode.mockRejectedValueOnce(new Error("boom"));
      await expect(session.setPermissionMode("plan")).resolves.toBeUndefined();
      expect(session.currentPermissionMode).toBe("default");
      const relevant = events.filter((event) => event.type === "permission_mode" || event.type === "error");
      expect(relevant).toEqual([
        { type: "permission_mode", mode: "plan" },
        { type: "permission_mode", mode: "default" },
        { type: "error", message: "권한 모드를 바꾸지 못했습니다: boom" },
      ]);
    });

    it("더 새로운 요청이 있으면 먼저 요청의 실패가 현재 값을 되돌리지 않는다", async () => {
      const { sdk, session, events } = createSession({ permissionMode: "default" });
      session.start();
      const first = deferred();
      sdk.calls[0]?.setPermissionMode.mockReturnValueOnce(first.promise);
      const firstCall = session.setPermissionMode("acceptEdits");
      const secondCall = session.setPermissionMode("plan");
      expect(session.currentPermissionMode).toBe("plan");
      first.reject(new Error("late"));
      await firstCall;
      await secondCall;
      expect(session.currentPermissionMode).toBe("plan");
      expect(modeEvents(events)).toEqual(["acceptEdits", "plan"]);
      expect(eventsOfType(events, "error").map((event) => event.message)).toEqual(["권한 모드를 바꾸지 못했습니다: late"]);
    });

    it("같은 모드를 다시 요청한 뒤 먼저 요청이 늦게 실패해도 현재 값을 되돌리지 않는다", async () => {
      const { sdk, session, events } = createSession({ permissionMode: "default" });
      session.start();
      const first = deferred();
      sdk.calls[0]?.setPermissionMode.mockReturnValueOnce(first.promise);
      const firstCall = session.setPermissionMode("acceptEdits");
      await session.setPermissionMode("plan");
      await session.setPermissionMode("acceptEdits");
      first.reject(new Error("late"));
      await firstCall;
      expect(session.currentPermissionMode).toBe("acceptEdits");
      expect(modeEvents(events)).toEqual(["acceptEdits", "plan", "acceptEdits"]);
      expect(eventsOfType(events, "error")).toHaveLength(1);
    });

    it("변경 대기 중 수신한 init의 권한 모드는 무시한다", async () => {
      const { session, events, calls, push } = createInjectableSession("default");
      session.start();
      const pending = deferred();
      calls[0]?.setPermissionMode.mockReturnValueOnce(pending.promise);
      const call = session.setPermissionMode("plan");
      push(initWith("default"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(session.currentPermissionMode).toBe("plan");
      expect(modeEvents(events)).toEqual(["plan"]);
      pending.resolve();
      await call;
    });

    it("시작 전 호출은 값만 저장하고 start의 options에 반영된다", async () => {
      const { sdk, session, events } = createSession();
      await session.setPermissionMode("acceptEdits");
      expect(session.currentPermissionMode).toBe("acceptEdits");
      expect(modeEvents(events)).toEqual(["acceptEdits"]);
      session.start();
      expect(sdk.calls[0]?.options.permissionMode).toBe("acceptEdits");
      expect(sdk.calls[0]?.setPermissionMode).not.toHaveBeenCalled();
    });

    it("종료 후 호출은 reject한다", async () => {
      const { session } = createSession();
      session.start();
      await session.close();
      await expect(session.setPermissionMode("plan")).rejects.toThrow("세션이 이미 종료되었습니다");
    });

    it("replace()와 replace(id) 후 새 query options에 현재 값이 들어간다", async () => {
      const { sdk, session } = createSession();
      session.start();
      await session.setPermissionMode("plan");
      await session.replace();
      await session.replace("other");
      expect(sdk.calls[1]?.options.permissionMode).toBe("plan");
      expect(sdk.calls[2]?.options.permissionMode).toBe("plan");
    });

    it("재연결 후 새 query options에 현재 값이 들어간다", async () => {
      const { sdk, session, events } = createSession();
      session.start();
      session.send("a");
      await vi.waitFor(() => expect(eventsOfType(events, "turn_result")).toHaveLength(1));
      await session.setPermissionMode("acceptEdits");
      sdk.failOnNextInput(new Error("끊김"));
      session.send("b");
      await vi.waitFor(() => expect(sdk.calls).toHaveLength(2));
      expect(sdk.calls[1]?.options.permissionMode).toBe("acceptEdits");
    });
  });
});
