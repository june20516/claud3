import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { HELP_TEXT } from "../src/commands.js";
import type { CommandContext } from "../src/commands.js";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { Session } from "../src/session.js";
import type { UiEvent } from "../src/types.js";
import type { UsageSnapshot } from "../src/usageStore.js";
import {
  MultilineBuffer,
  createPlainUi,
  formatEvent,
  formatStatusLine,
  parseDecision,
  parsePlanDecision,
} from "../src/ui/plain.js";
import type { PlainRunOptions } from "../src/ui/plain.js";

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

describe("parsePlanDecision", () => {
  it("y/yes는 allow, e는 allowAcceptEdits, n/no는 deny (대소문자·앞뒤 공백 무시)", () => {
    expect(parsePlanDecision("y")).toBe("allow");
    expect(parsePlanDecision("yes")).toBe("allow");
    expect(parsePlanDecision("E")).toBe("allowAcceptEdits");
    expect(parsePlanDecision(" n ")).toBe("deny");
    expect(parsePlanDecision("no")).toBe("deny");
  });

  it("a와 빈 답을 포함한 그 밖의 답은 undefined", () => {
    expect(parsePlanDecision("a")).toBeUndefined();
    expect(parsePlanDecision("")).toBeUndefined();
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
    expect(formatEvent({ type: "tool_start", toolUseId: "t1", name: "Bash", summary: "npm test", input: {} })).toContain("⏺ Bash(npm test)");
  });

  it("Edit tool_start는 한 줄 뒤에 diff를 이어서 표시", () => {
    const text = formatEvent({
      type: "tool_start",
      toolUseId: "t1",
      name: "Edit",
      summary: "a.ts",
      input: { file_path: "a.ts", old_string: "old", new_string: "new" },
    });
    expect(text).toContain("⏺ Edit(a.ts)");
    expect(text).toContain("- old");
    expect(text).toContain("+ new");
    expect(text.indexOf("⏺ Edit(a.ts)")).toBeLessThan(text.indexOf("- old"));
  });

  it("permission_mode는 '권한 모드: <설명>' 한 줄", () => {
    expect(stripVTControlCharacters(formatEvent({ type: "permission_mode", mode: "plan" }))).toBe(
      "\n권한 모드: plan — 계획만 세우고 도구 실행 안 함\n",
    );
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

describe("MultilineBuffer", () => {
  it("줄 끝이 \\이면 모으고, 다음 줄에서 \\n으로 이어 돌려준다", () => {
    const buffer = new MultilineBuffer();
    expect(buffer.push("a\\")).toBeUndefined();
    expect(buffer.isCollecting).toBe(true);
    expect(buffer.push("b")).toBe("a\nb");
    expect(buffer.isCollecting).toBe(false);
  });

  it("\\ 없는 줄은 그대로 돌려준다", () => {
    expect(new MultilineBuffer().push("x")).toBe("x");
  });

  it("reset 후에는 모으는 중이 아니고 이전 줄을 버린다", () => {
    const buffer = new MultilineBuffer();
    buffer.push("a\\");
    buffer.reset();
    expect(buffer.isCollecting).toBe(false);
    expect(buffer.push("c")).toBe("c");
  });
});

describe("formatStatusLine", () => {
  it("모델 · 세션 비용 · 크레딧 잔여 추정", () => {
    const text = formatStatusLine({ model: "m", sessionCostUsd: 0.0123, remainingCreditUsd: 99.5 });
    expect(text).toContain("m · 세션 $0.0123 · 크레딧 잔여 추정 $99.50");
  });

  it("권한 모드가 있으면 모델 다음에 표시한다", () => {
    const text = formatStatusLine({ model: "m", permissionMode: "plan", sessionCostUsd: 0.0123, remainingCreditUsd: 99.5 });
    expect(stripVTControlCharacters(text)).toBe("m · plan · 세션 $0.0123 · 크레딧 잔여 추정 $99.50");
  });

  it("권한 모드가 없으면 그 자리를 생략한다", () => {
    const text = formatStatusLine({ model: "m", sessionCostUsd: 0.0123, remainingCreditUsd: 99.5 });
    expect(stripVTControlCharacters(text)).toBe("m · 세션 $0.0123 · 크레딧 잔여 추정 $99.50");
  });

  it("모델이 없으면 '기본 모델'", () => {
    expect(formatStatusLine({ sessionCostUsd: 0, remainingCreditUsd: 0 })).toContain("기본 모델 · 세션 $0.0000");
  });
});

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "claud3-ui-"));
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
  } catch {
    return [];
  }
}

describe("createPlainUi 입력 기록", () => {
  it("기록 파일을 읽어 시작하고, 새 입력을 첫 줄에 저장한다", async () => {
    const historyFile = join(createTempDir(), "history");
    writeFileSync(historyFile, "old2\nold1\n");
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    createPlainUi({ input, output, terminal: true, historyFile });

    input.write("new\r");

    await vi.waitFor(() => expect(readLines(historyFile)).toEqual(["new", "old2", "old1"]));
  });

  it("권한 질문의 답은 기록에 남기지 않는다", async () => {
    const historyFile = join(createTempDir(), "history");
    writeFileSync(historyFile, "old\n");
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString();
    });
    const ui = createPlainUi({ input, output, terminal: true, historyFile });

    const decision = ui.prompter({ toolName: "Bash", summary: "ls" });
    await vi.waitFor(() => expect(written).toContain("허용할까요?"));
    input.write("y\r");
    await expect(decision).resolves.toBe("allow");
    input.write("real\r");

    await vi.waitFor(() => expect(readLines(historyFile)).toEqual(["real", "old"]));
  });

  it.skipIf(process.platform === "win32")("기록 파일 권한을 0600으로 저장한다", async () => {
    const dir = createTempDir();
    const newFile = join(dir, "new-history");
    const existingFile = join(dir, "existing-history");
    writeFileSync(existingFile, "old\n");
    chmodSync(existingFile, 0o644);

    for (const historyFile of [newFile, existingFile]) {
      const input = new PassThrough();
      createPlainUi({ input, output: new PassThrough(), terminal: true, historyFile });
      input.write("hello\r");
      await vi.waitFor(() => expect(readLines(historyFile)[0]).toBe("hello"));
      await vi.waitFor(() => expect(statSync(historyFile).mode & 0o777).toBe(0o600));
    }
  });

  it("기록 파일 디렉터리가 없으면 만든다", async () => {
    const historyFile = join(createTempDir(), "nested", "dir", "history");
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    createPlainUi({ input, output, terminal: true, historyFile });

    input.write("hello\r");

    await vi.waitFor(() => expect(readLines(historyFile)).toEqual(["hello"]));
  });

  it("쓰기에 실패하면 처음 한 번만 경고한다", async () => {
    const dir = createTempDir();
    const blocker = join(dir, "file");
    writeFileSync(blocker, "");
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString();
    });
    createPlainUi({ input, output, terminal: true, historyFile: join(blocker, "history") });

    input.write("a\r");
    await vi.waitFor(() => expect(written).toContain("입력 기록을 저장하지 못했습니다"));
    input.write("b\r");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(written.split("입력 기록을 저장하지 못했습니다").length - 1).toBe(1);
  });
});

class FakeSession {
  readonly sent: string[] = [];
  readonly listeners: ((event: UiEvent) => void)[] = [];
  isBusy = false;
  totalCostUsd = 0;
  currentModel: string | undefined = "claude-test";
  currentPermissionMode: PermissionMode | undefined = undefined;
  readonly setPermissionMode = vi.fn(async (_mode: PermissionMode) => undefined);
  sessionId: string | undefined = "s1";
  readonly interrupt = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => {
    this.emit({ type: "session_closed", sessionId: this.sessionId, totalCostUsd: this.totalCostUsd });
  });
  readonly setModel = vi.fn(async () => undefined);
  readonly listModels = vi.fn(async () => []);
  readonly replace = vi.fn(async () => undefined);

  onEvent(listener: (event: UiEvent) => void): void {
    this.listeners.push(listener);
  }

  start(): void {}

  send(text: string): void {
    this.sent.push(text);
  }

  emit(event: UiEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  asSession(): Session {
    return this as unknown as Session;
  }
}

const SNAPSHOT: UsageSnapshot = { startingCreditUsd: 100, spentUsd: 0.5 };

interface RunUiOverrides {
  recordUsage?: PlainRunOptions["recordUsage"];
  readUsage?: CommandContext["readUsage"];
}

function createRunUi(overrides: RunUiOverrides = {}, terminal = false) {
  const input = new PassThrough();
  const output = new PassThrough();
  const state = { written: "" };
  output.on("data", (chunk: Buffer) => {
    state.written += chunk.toString();
  });
  const session = new FakeSession();
  const printed: string[] = [];
  const commandContext: CommandContext = {
    session: session.asSession(),
    readUsage: overrides.readUsage ?? (async () => SNAPSHOT),
    print: (text) => printed.push(text),
  };
  const recordUsage = overrides.recordUsage ?? vi.fn(async (_costUsd: number) => SNAPSHOT);
  const ui = createPlainUi({ input, output, terminal });
  const running = ui.run(session.asSession(), { commandContext, recordUsage });
  const plain = (): string => stripVTControlCharacters(state.written);
  return { input, state, plain, session, printed, recordUsage, running, ui };
}

describe("createPlainUi run", () => {
  it("\\로 끝나는 줄은 '… ' 프롬프트로 이어 받고, 합친 입력을 보낸다", async () => {
    const { input, plain, session } = createRunUi();

    input.write("a\\\n");
    await vi.waitFor(() => expect(plain()).toContain("… "));
    expect(session.sent).toEqual([]);
    input.write("b\n");

    await vi.waitFor(() => expect(session.sent).toEqual(["a\nb"]));
  });

  it("내장 명령은 Claude에게 보내지 않고 실행한다", async () => {
    const { input, session, printed } = createRunUi();

    input.write("/help\n");

    await vi.waitFor(() => expect(printed).toEqual([HELP_TEXT]));
    expect(session.sent).toEqual([]);
  });

  it("명령이 실패하면 '오류: <message>'를 출력한다", async () => {
    const { input, plain } = createRunUi({
      readUsage: async () => {
        throw new Error("읽기 실패");
      },
    });

    input.write("/cost\n");

    await vi.waitFor(() => expect(plain()).toContain("오류: 읽기 실패"));
  });

  it("turn_result 뒤에 사용량을 기록하고 상태 줄을 출력한다", async () => {
    const recordUsage = vi.fn(async (_costUsd: number) => SNAPSHOT);
    const { plain, session } = createRunUi({ recordUsage });
    session.totalCostUsd = 0.0123;

    session.emit({ type: "text_delta", text: "**굵게** 끝" });
    session.emit({ type: "turn_result", costUsd: 0.0123, totalCostUsd: 0.0123, isError: false });

    const statusLine = "claude-test · 세션 $0.0123 · 크레딧 잔여 추정 $99.50";
    await vi.waitFor(() => expect(plain()).toContain(statusLine));
    expect(recordUsage).toHaveBeenCalledWith(0.0123);
    const text = plain();
    expect(text).toContain("굵게 끝");
    expect(text).not.toContain("**");
    expect(text.indexOf("굵게 끝")).toBeLessThan(text.indexOf("누적 $0.0123"));
    expect(text.indexOf("누적 $0.0123")).toBeLessThan(text.indexOf(statusLine));
  });

  it("turn_result 뒤의 이벤트는 상태 줄 다음에 출력한다", async () => {
    let finishRecord: (snapshot: UsageSnapshot) => void = () => undefined;
    const recordUsage = vi.fn(
      () =>
        new Promise<UsageSnapshot>((resolve) => {
          finishRecord = resolve;
        }),
    );
    const { plain, session } = createRunUi({ recordUsage });

    session.emit({ type: "turn_result", costUsd: 0.01, totalCostUsd: 0.01, isError: false });
    session.emit({ type: "error", message: "다음 오류" });
    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalled());
    expect(plain()).not.toContain("다음 오류");
    finishRecord(SNAPSHOT);

    await vi.waitFor(() => expect(plain()).toContain("다음 오류"));
    expect(plain().indexOf("크레딧 잔여 추정")).toBeLessThan(plain().indexOf("다음 오류"));
  });

  it("사용량 기록이 실패하면 오류 한 줄을 출력하고 상태 줄은 생략한다", async () => {
    const recordUsage = vi.fn(async (): Promise<UsageSnapshot> => {
      throw new Error("디스크 가득");
    });
    const { plain, session } = createRunUi({ recordUsage });

    session.emit({ type: "turn_result", costUsd: 0.01, totalCostUsd: 0.01, isError: false });

    await vi.waitFor(() => expect(plain()).toContain("디스크 가득"));
    expect(plain()).not.toContain("크레딧 잔여 추정");
  });

  it("이벤트 렌더링이 던져도 오류 한 줄을 출력하고 다음 이벤트를 계속 처리한다", async () => {
    const { plain, session } = createRunUi();
    const broken = {
      type: "error",
      get message(): string {
        throw new Error("렌더 실패");
      },
    } as UiEvent;

    session.emit(broken);
    session.emit({ type: "error", message: "다음 오류" });

    await vi.waitFor(() => expect(plain()).toContain("다음 오류"));
    expect(plain()).toContain("오류: 렌더 실패");
  });

  it("여러 줄 입력 중 Ctrl+C는 모은 줄을 버리고 종료 확인을 하지 않는다", async () => {
    const { input, plain, session } = createRunUi({}, true);

    input.write("a\\\r");
    await vi.waitFor(() => expect(plain()).toContain("… "));
    input.write("\x03");
    input.write("b\r");

    await vi.waitFor(() => expect(session.sent).toEqual(["b"]));
    expect(plain()).not.toContain("한 번 더 누르면 종료합니다");
    expect(session.close).not.toHaveBeenCalled();
  });

  it("session_closed가 오면 run이 끝난다", async () => {
    const { session, running } = createRunUi();

    await session.close();

    await expect(running).resolves.toBeUndefined();
  });
});

describe("createPlainUi 권한 모드", () => {
  it("Shift+Tab은 다음 권한 모드로 바꾸고 입력 줄에 문자를 남기지 않는다", async () => {
    const { input, session } = createRunUi({}, true);
    session.currentPermissionMode = "acceptEdits";

    input.write("\x1b[Z");
    await vi.waitFor(() => expect(session.setPermissionMode).toHaveBeenCalledTimes(1));
    expect(session.setPermissionMode).toHaveBeenCalledWith("plan");
    input.write("abc\r");

    await vi.waitFor(() => expect(session.sent).toEqual(["abc"]));
  });

  it("권한 질문이 열린 동안 Shift+Tab은 모드를 바꾸지 않는다", async () => {
    const { input, plain, session, ui } = createRunUi({}, true);

    const decision = ui.prompter({ toolName: "Bash", summary: "ls" });
    await vi.waitFor(() => expect(plain()).toContain("허용할까요?"));
    input.write("\x1b[Z");
    input.write("y\r");

    await expect(decision).resolves.toBe("allow");
    expect(session.setPermissionMode).not.toHaveBeenCalled();
  });

  it("모드 변경이 reject되면 오류 한 줄을 출력하고 계속한다", async () => {
    const { input, plain, session } = createRunUi({}, true);
    session.setPermissionMode.mockRejectedValueOnce(new Error("세션이 종료되었습니다"));

    input.write("\x1b[Z");
    await vi.waitFor(() => expect(plain()).toContain("오류: 세션이 종료되었습니다"));
    input.write("abc\r");

    await vi.waitFor(() => expect(session.sent).toEqual(["abc"]));
  });

  it("turn_result 뒤 상태 줄에 현재 권한 모드를 표시한다", async () => {
    const { plain, session } = createRunUi();
    session.currentPermissionMode = "plan";

    session.emit({ type: "turn_result", costUsd: 0, totalCostUsd: 0, isError: false });

    await vi.waitFor(() => expect(plain()).toContain("claude-test · plan · 세션 $0.0000"));
  });
});

const PLAN_QUESTION = "계획을 승인할까요? [y]승인 [e]승인+편집 자동 허용 [n]계속 계획 › ";

describe("createPlainUi 계획 질문", () => {
  it("계획 본문을 질문보다 먼저 보이고, 잘못된 답은 다시 묻고 e는 allowAcceptEdits", async () => {
    const { input, state, ui } = createTestUi();
    const plain = (): string => stripVTControlCharacters(state.written);

    const decision = ui.prompter({ toolName: "ExitPlanMode", summary: "…", plan: { text: "# 계획\n- 하나" } });
    await vi.waitFor(() => expect(plain()).toContain(PLAN_QUESTION));
    const text = plain();
    expect(text).toContain("계획");
    expect(text).toContain("• 하나");
    expect(text.indexOf("• 하나")).toBeLessThan(text.indexOf(PLAN_QUESTION));
    expect(text).not.toContain("허용할까요?");

    input.write("a\n");
    await vi.waitFor(() => expect(plain().split("계획을 승인할까요?").length - 1).toBe(2));
    input.write("e\n");

    await expect(decision).resolves.toBe("allowAcceptEdits");
    expect(plain().split("• 하나").length - 1).toBe(1);
  });

  it("본문 없이 경로만 있으면 '계획 파일: <경로>'를 보인다", async () => {
    const { input, state, ui } = createTestUi();
    const plain = (): string => stripVTControlCharacters(state.written);

    const decision = ui.prompter({ toolName: "ExitPlanMode", summary: "요약", plan: { filePath: "/p/plan.md" } });
    await vi.waitFor(() => expect(plain()).toContain(PLAN_QUESTION));
    expect(plain()).toContain("계획 파일: /p/plan.md");
    expect(plain()).not.toContain("ExitPlanMode(요약)");
    input.write("y\n");

    await expect(decision).resolves.toBe("allow");
  });

  it("본문과 경로가 모두 없으면 기존 요약 줄만 보인다", async () => {
    const { input, state, ui } = createTestUi();
    const plain = (): string => stripVTControlCharacters(state.written);

    const decision = ui.prompter({ toolName: "ExitPlanMode", summary: "요약", plan: {} });
    await vi.waitFor(() => expect(plain()).toContain(PLAN_QUESTION));
    expect(plain()).toContain("ExitPlanMode(요약)");
    expect(plain()).not.toContain("계획 파일:");
    input.write("n\n");

    await expect(decision).resolves.toBe("deny");
  });

  it("닫히지 않은 코드 블록과 긴 계획도 모두 보이고 질문 줄에 색이 새지 않는다", async () => {
    vi.stubEnv("FORCE_COLOR", "1");
    try {
      const { input, state, ui } = createTestUi();
      const planLines = Array.from({ length: 300 }, (_, index) => `줄 ${index + 1}`);
      const text = ["```", "code", ...planLines].join("\n");

      const decision = ui.prompter({ toolName: "ExitPlanMode", summary: "…", plan: { text } });
      await vi.waitFor(() => expect(state.written).toContain(PLAN_QUESTION));
      const written = state.written;
      expect(written).toContain("\u001b[36m");
      const questionLine = written.slice(written.lastIndexOf("\n") + 1);
      expect(questionLine).toContain(PLAN_QUESTION);
      expect(questionLine).not.toContain("\u001b[36m");
      const shown = stripVTControlCharacters(written);
      for (const line of planLines) {
        expect(shown).toContain(`${line}\n`);
      }
      input.write("y\n");

      await expect(decision).resolves.toBe("allow");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
