import type { ModelInfo, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
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

const VALID_ID = "123e4567-e89b-12d3-a456-426614174000";

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
    currentPermissionMode: "default" as PermissionMode | undefined,
    setPermissionMode: vi.fn(async (_mode: PermissionMode) => {}),
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

  it("/mode는 command로 판정한다", () => {
    expect(parseInput("/mode")).toEqual({ kind: "command", name: "mode", argument: "" });
    expect(parseInput("/mode plan")).toEqual({ kind: "command", name: "mode", argument: "plan" });
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
    expect(printed).toEqual(["새 대화를 시작했습니다 (이전 세션: sess-1)"]);
  });

  it("/clear는 이전 세션이 없으면 이전 세션 표기를 붙이지 않는다", async () => {
    const { context, printed } = createContext({ sessionId: undefined });
    await runCommand(command("clear"), context);
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

  it("/resume id는 세션으로 이동하고 이전 세션을 표기한다", async () => {
    const { context, session, printed } = createContext();
    await runCommand(command("resume", VALID_ID), context);
    expect(session.replace).toHaveBeenCalledWith(VALID_ID);
    expect(printed).toEqual([`세션 ${VALID_ID}(으)로 이동했습니다 (이전 세션: sess-1)`]);
  });

  it("/resume은 이전 세션이 없으면 이전 세션 표기를 붙이지 않는다", async () => {
    const { context, printed } = createContext({ sessionId: undefined });
    await runCommand(command("resume", VALID_ID), context);
    expect(printed).toEqual([`세션 ${VALID_ID}(으)로 이동했습니다`]);
  });

  it("/resume 인자가 세션 ID 형식이 아니면 replace를 부르지 않는다", async () => {
    const { context, session, printed } = createContext();
    await runCommand(command("resume", "abc"), context);
    expect(session.replace).not.toHaveBeenCalled();
    expect(printed).toEqual(["세션 ID 형식이 아닙니다: abc"]);
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
    await runCommand(command("resume", VALID_ID), context);
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

  it("/mode는 현재 모드와 선택지를 출력한다", async () => {
    const { context, printed } = createContext({ currentPermissionMode: "plan" });
    await runCommand(command("mode"), context);
    expect(printed).toEqual([
      [
        "현재 모드: plan",
        "  default      위험한 도구는 매번 묻기",
        "  acceptEdits  파일 편집은 묻지 않고 허용",
        "* plan         계획만 세우고 도구 실행 안 함",
        "  auto         분류기가 판단, 애매하면 묻기",
        "바꾸려면: /mode <이름> · Shift+Tab",
      ].join("\n"),
    ]);
  });

  it("/mode는 현재 모드를 모르면 알 수 없음, 목록 밖 모드면 * 없이 이름을 표시한다", async () => {
    const unknown = createContext({ currentPermissionMode: undefined });
    await runCommand(command("mode"), unknown.context);
    expect(unknown.printed[0]).toMatch(/^현재 모드: 알 수 없음\n/);
    expect(unknown.printed[0]).not.toContain("*");

    const dontAsk = createContext({ currentPermissionMode: "dontAsk" });
    await runCommand(command("mode"), dontAsk.context);
    expect(dontAsk.printed[0]).toMatch(/^현재 모드: dontAsk\n/);
    expect(dontAsk.printed[0]).not.toContain("*");
  });

  it("/mode <이름>은 setPermissionMode를 호출하고 직접 출력하지 않는다", async () => {
    const { context, session, printed } = createContext();
    await runCommand(command("mode", "plan"), context);
    expect(session.setPermissionMode).toHaveBeenCalledWith("plan");
    expect(printed).toEqual([]);
  });

  it("/mode <이름>은 실행 중(busy)에도 동작한다", async () => {
    const { context, session } = createContext({ isBusy: true });
    await runCommand(command("mode", "acceptEdits"), context);
    expect(session.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
  });

  it("/mode <현재 모드>는 호출 없이 안내한다", async () => {
    const { context, session, printed } = createContext({ currentPermissionMode: "plan" });
    await runCommand(command("mode", "plan"), context);
    expect(session.setPermissionMode).not.toHaveBeenCalled();
    expect(printed).toEqual(["이미 plan 모드입니다"]);
  });

  it("/mode 잘못된 이름은 호출 없이 안내한다", async () => {
    const { context, session, printed } = createContext();
    await runCommand(command("mode", "Plan"), context);
    expect(session.setPermissionMode).not.toHaveBeenCalled();
    expect(printed).toEqual(["알 수 없는 권한 모드: Plan (default, acceptEdits, plan, auto)"]);
  });

  it("HELP_TEXT에 권한 모드 안내가 있다", () => {
    for (const line of [
      "  /mode            현재 권한 모드와 선택지",
      "  /mode <이름>     권한 모드 바꾸기 (default, acceptEdits, plan, auto)",
      "  Shift+Tab        권한 모드 순환 (default → acceptEdits → plan → auto)",
      "  계획 승인(plan 모드): y 승인 · e 승인+편집 자동 허용 · n 계속 계획",
      "  claud3 --permission-mode <이름>  권한 모드 지정해 시작",
    ]) {
      expect(HELP_TEXT.split("\n")).toContain(line);
    }
  });

  it("HELP_TEXT 실행 옵션에 --plain 안내가 있다", () => {
    expect(HELP_TEXT.split("\n")).toContain("  claud3 --plain           readline 화면으로 시작");
  });

  it("/help에 개발판·안정판 안내가 실행 옵션 뒤에 있다", () => {
    expect(HELP_TEXT).toContain("개발판·안정판");
    expect(HELP_TEXT.indexOf("실행 옵션")).toBeLessThan(HELP_TEXT.indexOf("개발판·안정판"));
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
