import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { HELP_TEXT, parseInput, runCommand } from "../src/commands.js";
import type { CommandContext, ParsedInput } from "../src/commands.js";

type CommandInput = Extract<ParsedInput, { kind: "command" }>;

function command(name: CommandInput["name"], argument = ""): CommandInput {
  return { kind: "command", name, argument };
}

const MODELS: ModelInfo[] = [
  { value: "claude-a", displayName: "A", description: "첫째" },
  { value: "claude-b", displayName: "B", description: "둘째" },
];

function createContext(overrides: Partial<CommandContext["session"]> = {}) {
  const printed: string[] = [];
  const session = {
    isBusy: false,
    totalCostUsd: 1.23456,
    currentModel: "claude-a" as string | undefined,
    sessionId: "sess-1" as string | undefined,
    setModel: vi.fn(async (_model: string) => {}),
    listModels: vi.fn(async () => MODELS),
    replace: vi.fn(async (_resume?: string) => {}),
    ...overrides,
  } satisfies CommandContext["session"];
  const context: CommandContext = {
    session,
    readUsage: async () => ({ startingCreditUsd: 100, spentUsd: 12.34567 }),
    print: (text) => printed.push(text),
  };
  return { context, session, printed };
}

describe("parseInput", () => {
  it("/cost는 command로 판정한다", () => {
    expect(parseInput("/cost")).toEqual({ kind: "command", name: "cost", argument: "" });
  });

  it("앞뒤 공백을 제거하고 인자를 분리한다", () => {
    expect(parseInput(" /model  claude-x ")).toEqual({ kind: "command", name: "model", argument: "claude-x" });
  });

  it("인자 없는 /model은 빈 인자다", () => {
    expect(parseInput("/model")).toEqual({ kind: "command", name: "model", argument: "" });
  });

  it("알 수 없거나 플러그인 슬래시는 prompt다", () => {
    expect(parseInput("/suberpower:brainstorming")).toEqual({ kind: "prompt", text: "/suberpower:brainstorming" });
    expect(parseInput("/unknown")).toEqual({ kind: "prompt", text: "/unknown" });
  });

  it("명령 이름은 대소문자를 구분한다", () => {
    expect(parseInput("/COST").kind).toBe("prompt");
  });

  it("일반 문장은 prompt다", () => {
    expect(parseInput("hello")).toEqual({ kind: "prompt", text: "hello" });
  });
});

describe("runCommand", () => {
  it("/cost는 세션·누적·남은 크레딧을 출력한다", async () => {
    const { context, printed } = createContext();
    await runCommand(command("cost"), context);
    expect(printed).toEqual(["세션 $1.2346 · 전체 누적 $12.3457 · 남은 크레딧 추정 $87.65 (정확한 값은 Console)"]);
  });

  it("/clear는 새 대화를 시작한다", async () => {
    const { context, session, printed } = createContext();
    await runCommand(command("clear"), context);
    expect(session.replace).toHaveBeenCalledWith();
    expect(printed).toEqual(["새 대화를 시작했습니다"]);
  });

  it("/model x는 모델을 바꾼다", async () => {
    const { context, session, printed } = createContext();
    await runCommand(command("model", "x"), context);
    expect(session.setModel).toHaveBeenCalledWith("x");
    expect(printed).toEqual(["모델을 x(으)로 바꿨습니다"]);
  });

  it("/model은 현재 모델과 목록을 출력하고 현재 모델에 *를 붙인다", async () => {
    const { context, printed } = createContext();
    await runCommand(command("model"), context);
    expect(printed).toEqual([
      [
        "현재 모델: claude-a",
        "* claude-a  A — 첫째",
        "  claude-b  B — 둘째",
        "바꾸려면: /model <ID>",
      ].join("\n"),
    ]);
  });

  it("현재 모델이 없으면 기본값으로 표시한다", async () => {
    const { context, printed } = createContext({ currentModel: undefined });
    await runCommand(command("model"), context);
    expect(printed[0]?.split("\n")[0]).toBe("현재 모델: 기본값");
  });

  it("listModels가 실패하면 안내 문구만 출력한다", async () => {
    const { context, printed } = createContext({
      listModels: vi.fn(async () => {
        throw new Error("연결 없음");
      }),
    });
    await runCommand(command("model"), context);
    expect(printed).toEqual([
      ["현재 모델: claude-a", "모델 목록을 가져오지 못했습니다: 연결 없음", "바꾸려면: /model <ID>"].join("\n"),
    ]);
  });

  it("busy여도 인자 없는 /model은 목록을 출력한다", async () => {
    const { context, printed } = createContext({ isBusy: true });
    await runCommand(command("model"), context);
    expect(printed[0]).toContain("현재 모델: claude-a");
  });

  it("/resume id는 세션으로 이동한다", async () => {
    const { context, session, printed } = createContext();
    await runCommand(command("resume", "abc"), context);
    expect(session.replace).toHaveBeenCalledWith("abc");
    expect(printed).toEqual(["세션 abc(으)로 이동했습니다"]);
  });

  it("인자 없는 /resume은 사용법을 출력한다", async () => {
    const { context, session, printed } = createContext({ isBusy: true });
    await runCommand(command("resume"), context);
    expect(session.replace).not.toHaveBeenCalled();
    expect(printed).toEqual(["사용법: /resume <session-id>  (현재 세션: sess-1)"]);
  });

  it("세션 ID가 없으면 사용법에 없음을 표시한다", async () => {
    const { context, printed } = createContext({ sessionId: undefined });
    await runCommand(command("resume"), context);
    expect(printed).toEqual(["사용법: /resume <session-id>  (현재 세션: 없음)"]);
  });

  it("busy 중 /model x·/clear·/resume id는 안내만 출력한다", async () => {
    const { context, session, printed } = createContext({ isBusy: true });
    await runCommand(command("model", "x"), context);
    await runCommand(command("clear"), context);
    await runCommand(command("resume", "abc"), context);
    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.replace).not.toHaveBeenCalled();
    expect(printed).toEqual(Array(3).fill("턴이 끝난 뒤 다시 입력해 주세요"));
  });

  it("setModel이 실패하면 에러 메시지를 출력한다", async () => {
    const { context, printed } = createContext({
      setModel: vi.fn(async () => {
        throw new Error("세션이 시작되지 않았습니다");
      }),
    });
    await runCommand(command("model", "x"), context);
    expect(printed).toEqual(["세션이 시작되지 않았습니다"]);
  });

  it("/help는 HELP_TEXT를 그대로 출력한다", async () => {
    const { context, printed } = createContext();
    await runCommand(command("help"), context);
    expect(printed).toEqual([HELP_TEXT]);
    expect(HELP_TEXT).toContain("/model <ID>");
    expect(HELP_TEXT).toContain("/resume <ID>");
    expect(HELP_TEXT).toContain("Esc");
    expect(HELP_TEXT).toContain("줄 끝에 \\ 를 붙이고");
  });
});
