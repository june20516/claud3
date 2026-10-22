import { Console } from "node:console";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../src/session.js";
import type { PermissionDecision, PermissionRequest, UiEvent } from "../src/types.js";
import type { UsageSnapshot } from "../src/usageStore.js";
import { App, InkUiStore, connectSession } from "../src/ui/ink/App.js";
import { InputBox, inputCursorOffset } from "../src/ui/ink/InputBox.js";
import { PermissionDialog } from "../src/ui/ink/PermissionDialog.js";
import { StatusBar } from "../src/ui/ink/StatusBar.js";
import { Transcript } from "../src/ui/ink/TranscriptView.js";
import { createInkUi } from "../src/ui/ink/index.js";
import { addNotice, addUserInput, initialTranscript, reduceTranscript } from "../src/ui/ink/transcript.js";
import type { UiRunOptions } from "../src/ui/runOptions.js";

const ENTER = "\r";
const ESCAPE = "\u001b";
const UP = "\u001b[A";
const DOWN = "\u001b[B";
const SHIFT_TAB = "\u001b[Z";
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";

type Frame = () => string | undefined;

function plainFrame(lastFrame: Frame): string {
  return stripVTControlCharacters(lastFrame() ?? "");
}

/** 키 하나를 보내고 Ink가 처리할 시간을 준다. */
async function press(stdin: { write(data: string): void }, data: string): Promise<void> {
  stdin.write(data);
  await new Promise((resolve) => setTimeout(resolve, 20));
}

class FakeSession {
  readonly sent: string[] = [];
  readonly listeners: ((event: UiEvent) => void)[] = [];
  isBusy = false;
  totalCostUsd = 0;
  currentModel: string | undefined = "claude-test";
  currentPermissionMode: PermissionMode | undefined = "default";
  sessionId: string | undefined = "s1";
  readonly start = vi.fn(() => undefined);
  readonly setPermissionMode = vi.fn(async (_mode: PermissionMode) => undefined);
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

function renderApp(
  overrides: { recordUsage?: UiRunOptions["recordUsage"]; readUsage?: UiRunOptions["commandContext"]["readUsage"] } = {},
) {
  const session = new FakeSession();
  const store = new InkUiStore();
  const recordUsage = overrides.recordUsage ?? vi.fn(async (_costUsd: number) => SNAPSHOT);
  const options: UiRunOptions = {
    commandContext: { session: session.asSession(), readUsage: overrides.readUsage ?? (async () => SNAPSHOT) },
    recordUsage,
  };
  const onClosed = vi.fn();
  connectSession(store, session.asSession(), options, onClosed);
  const view = render(
    <App store={store} session={session.asSession()} commandContext={options.commandContext} initialHistory={[]} />,
  );
  const frame = (): string => plainFrame(view.lastFrame);
  return { ...view, session, store, recordUsage, onClosed, frame };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Transcript", () => {
  it("user·assistant(마크다운)·tool(diff)·notice를 각각 표시한다", async () => {
    let state = addUserInput(initialTranscript, "안녕");
    state = reduceTranscript(state, { type: "text_delta", text: "**굵게** 답변\n" });
    state = reduceTranscript(state, {
      type: "tool_start",
      toolUseId: "t1",
      name: "Edit",
      summary: "a.ts",
      input: { file_path: "a.ts", old_string: "old line", new_string: "new line" },
    });
    state = reduceTranscript(state, { type: "tool_end", toolUseId: "t1", isError: true, summary: "실패 요약" });
    state = addNotice(state, "error", "알림 문구");

    const { lastFrame } = render(<Transcript state={state} />);
    const text = plainFrame(lastFrame);

    expect(text).toContain("> 안녕");
    expect(text).toContain("굵게 답변");
    expect(text).not.toContain("**");
    expect(text).toContain("⏺ Edit(a.ts)");
    expect(text).toContain("- old line");
    expect(text).toContain("+ new line");
    expect(text).toContain("⎿ 실패 요약");
    expect(text).toContain("알림 문구");
  });

  it("동적 영역에는 아직 끝나지 않은 응답 줄과 실행 중 표시 한 줄만 그린다", () => {
    let state = reduceTranscript(initialTranscript, {
      type: "tool_start",
      toolUseId: "t1",
      name: "Edit",
      summary: "a.ts",
      input: { file_path: "a.ts", old_string: "old line", new_string: "new line" },
    });
    state = reduceTranscript(state, { type: "text_delta", text: "완성 줄\n진행 중" });

    // done(Static)을 비우면 동적 영역만 남는다.
    const { lastFrame } = render(<Transcript state={{ ...state, done: [] }} />);
    const lines = plainFrame(lastFrame)
      .split("\n")
      .filter((line) => line.trim() !== "");

    expect(lines).toEqual(["⏺ Edit(a.ts) 실행 중…", "진행 중"]);
  });

  it("tool_start 직후 도구 줄과 diff는 확정 영역에 있다", () => {
    const state = reduceTranscript(initialTranscript, {
      type: "tool_start",
      toolUseId: "t1",
      name: "Edit",
      summary: "a.ts",
      input: { file_path: "a.ts", old_string: "old line", new_string: "new line" },
    });

    const { lastFrame } = render(<Transcript state={{ ...state, running: [] }} />);
    const text = plainFrame(lastFrame);

    expect(text).toContain("⏺ Edit(a.ts)");
    expect(text).toContain("- old line");
    expect(text).toContain("+ new line");
  });

  it("같은 응답의 이어지는 줄과 도구 오류 줄은 빈 줄 없이 붙는다", () => {
    let state = reduceTranscript(initialTranscript, { type: "text_delta", text: "첫 줄\n" });
    state = reduceTranscript(state, { type: "text_delta", text: "둘째 줄\n" });
    state = reduceTranscript(state, { type: "tool_start", toolUseId: "t1", name: "Bash", summary: "ls", input: {} });
    state = reduceTranscript(state, { type: "tool_end", toolUseId: "t1", isError: true, summary: "실패" });

    const { lastFrame } = render(<Transcript state={state} />);

    expect(plainFrame(lastFrame)).toContain("첫 줄\n둘째 줄\n\n⏺ Bash(ls)\n  ⎿ 실패");
  });
});

describe("PermissionDialog (도구)", () => {
  const request: PermissionRequest = { toolName: "Bash", summary: "rm -rf build" };

  function renderDialog() {
    const onDecision = vi.fn((_decision: PermissionDecision) => undefined);
    const view = render(<PermissionDialog request={request} onDecision={onDecision} />);
    return { ...view, onDecision };
  }

  it("제목과 선택지를 보인다", () => {
    const { lastFrame } = renderDialog();
    const text = plainFrame(lastFrame);

    expect(text).toContain("Bash(rm -rf build) 허용할까요?");
    expect(text).toContain("이번만 허용");
    expect(text).toContain("세션 동안 항상 허용");
    expect(text).toContain("거부");
  });

  it("a는 always, y는 allow", async () => {
    const always = renderDialog();
    await press(always.stdin, "a");
    expect(always.onDecision).toHaveBeenCalledWith("always");

    const allow = renderDialog();
    await press(allow.stdin, "y");
    expect(allow.onDecision).toHaveBeenCalledWith("allow");
  });

  it("Esc는 deny", async () => {
    const { stdin, onDecision } = renderDialog();

    stdin.write(ESCAPE);

    await vi.waitFor(() => expect(onDecision).toHaveBeenCalledWith("deny"));
  });

  it("한 청크로 들어온 ↓ 두 번 + Enter도 deny", async () => {
    const { stdin, onDecision } = renderDialog();

    await press(stdin, `${DOWN}${DOWN}${ENTER}`);

    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith("deny");
  });

  it("↓ 두 번 + Enter는 deny", async () => {
    const { stdin, onDecision } = renderDialog();

    await press(stdin, DOWN);
    await press(stdin, DOWN);
    await press(stdin, ENTER);

    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith("deny");
  });

  it("Ctrl+A는 단축키 a로 보지 않는다", async () => {
    const { stdin, onDecision } = renderDialog();

    await press(stdin, "\u0001");

    expect(onDecision).not.toHaveBeenCalled();
  });
});

describe("PermissionDialog (계획)", () => {
  const request: PermissionRequest = { toolName: "ExitPlanMode", summary: "", plan: { text: "# 계획" } };

  function renderDialog() {
    const onDecision = vi.fn((_decision: PermissionDecision) => undefined);
    const view = render(<PermissionDialog request={request} onDecision={onDecision} />);
    return { ...view, onDecision };
  }

  it("계획 질문과 선택지를 보인다", () => {
    const text = plainFrame(renderDialog().lastFrame);

    expect(text).toContain("계획을 승인할까요?");
    expect(text).toContain("승인+편집 자동 허용");
    expect(text).toContain("계속 계획");
  });

  it("e는 allowAcceptEdits, n은 deny", async () => {
    const edits = renderDialog();
    await press(edits.stdin, "e");
    expect(edits.onDecision).toHaveBeenCalledWith("allowAcceptEdits");

    const deny = renderDialog();
    await press(deny.stdin, "n");
    expect(deny.onDecision).toHaveBeenCalledWith("deny");
  });
});

describe("InputBox", () => {
  function renderInput(initialHistory: string[] = []) {
    const onSubmit = vi.fn((_text: string) => undefined);
    const onInterrupt = vi.fn();
    const onHistoryChange = vi.fn((_history: string[]) => undefined);
    const view = render(
      <InputBox
        isActive
        initialHistory={initialHistory}
        onSubmit={onSubmit}
        onInterrupt={onInterrupt}
        onHistoryChange={onHistoryChange}
      />,
    );
    return { ...view, onSubmit, onInterrupt, onHistoryChange, frame: () => plainFrame(view.lastFrame) };
  }

  it("hello + Enter는 onSubmit('hello')", async () => {
    const { stdin, onSubmit, frame } = renderInput();

    await press(stdin, "hello");
    expect(frame()).toContain("> hello");
    await press(stdin, ENTER);

    expect(onSubmit).toHaveBeenCalledWith("hello");
  });

  it("a\\ + Enter 뒤 b + Enter는 onSubmit('a\\nb')이고 이어 받는 동안 '… ' 프롬프트를 보인다", async () => {
    const { stdin, onSubmit, frame } = renderInput();

    await press(stdin, "a\\");
    await press(stdin, ENTER);
    expect(onSubmit).not.toHaveBeenCalled();
    // Ink는 줄 끝 공백(빈 커서)을 지우므로 프롬프트 기호만 본다.
    expect(frame()).toContain("\n…");
    await press(stdin, "b");
    await press(stdin, ENTER);

    expect(onSubmit).toHaveBeenCalledWith("a\nb");
  });

  it("글자와 Enter가 한 청크로 오면 제출한다(한글 IME 조합 중 Return)", async () => {
    const { stdin, onSubmit, frame } = renderInput();

    await press(stdin, "안녕\r");

    expect(onSubmit).toHaveBeenCalledWith("안녕");
    expect(frame()).not.toContain("안녕");
  });

  it("한 청크 안의 줄마다 제출하고 줄 끝 \\ 이어 받기도 적용한다", async () => {
    const { stdin, onSubmit } = renderInput();

    await press(stdin, "a\\\rb\r");

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("a\nb");
  });

  it("대괄호 붙여넣기는 줄바꿈째 넣고 제출하지 않는다", async () => {
    const { stdin, onSubmit } = renderInput();

    await press(stdin, "\u001b[200~첫 줄\r둘째 줄\u001b[201~");
    expect(onSubmit).not.toHaveBeenCalled();
    await press(stdin, ENTER);

    expect(onSubmit).toHaveBeenCalledWith("첫 줄\n둘째 줄");
  });

  it("↑는 직전 입력을 보이고 보낸 줄을 기록에 넣는다", async () => {
    const { stdin, frame, onHistoryChange } = renderInput(["옛 입력"]);

    await press(stdin, "hello");
    await press(stdin, ENTER);
    expect(onHistoryChange).toHaveBeenLastCalledWith(["hello", "옛 입력"]);
    await press(stdin, UP);
    expect(frame()).toContain("> hello");
    await press(stdin, UP);
    expect(frame()).toContain("> 옛 입력");
    await press(stdin, DOWN);
    await press(stdin, DOWN);
    expect(frame()).not.toContain("hello");
  });

  it("한 청크로 들어온 Backspace 여러 개를 모두 처리한다", async () => {
    const { stdin, onSubmit } = renderInput();

    await press(stdin, "abcd");
    await press(stdin, "\u007f\u007f\u007f");
    await press(stdin, ENTER);

    expect(onSubmit).toHaveBeenCalledWith("a");
  });

  it("한 청크로 들어온 ← 여러 개 뒤 입력은 그 위치에 들어간다", async () => {
    const { stdin, onSubmit } = renderInput();

    await press(stdin, "abc");
    await press(stdin, "\u001b[D\u001b[D");
    await press(stdin, "X");
    await press(stdin, ENTER);

    expect(onSubmit).toHaveBeenCalledWith("aXbc");
  });

  it("한 청크로 들어온 ↑ 두 번은 두 칸 앞 기록을 보인다", async () => {
    const { stdin, onSubmit } = renderInput(["둘째", "첫째"]);

    await press(stdin, `${UP}${UP}`);
    await press(stdin, ENTER);

    expect(onSubmit).toHaveBeenCalledWith("첫째");
  });

  it("전각 문자를 지우면 한 글자씩 지워진다", async () => {
    const { stdin, onSubmit } = renderInput();

    await press(stdin, "한글");
    await press(stdin, "\u007f");
    await press(stdin, ENTER);

    expect(onSubmit).toHaveBeenCalledWith("한");
  });

  it("여러 줄 입력 중 Ctrl+C는 모은 줄을 버리고 onInterrupt를 부르지 않는다", async () => {
    const { stdin, onSubmit, onInterrupt, frame } = renderInput();

    await press(stdin, "a\\");
    await press(stdin, ENTER);
    await press(stdin, CTRL_C);
    expect(frame()).not.toContain("…");
    await press(stdin, "b");
    await press(stdin, ENTER);

    expect(onSubmit).toHaveBeenCalledWith("b");
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it("여러 줄 입력이 아니면 Ctrl+C는 onInterrupt를 부른다", async () => {
    const { stdin, onInterrupt } = renderInput();

    await press(stdin, CTRL_C);

    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });
});

describe("inputCursorOffset", () => {
  it("빈 입력이면 프롬프트 바로 뒤", () => {
    expect(inputCursorOffset({ collectedLines: [], textBeforeCursor: "", columns: 80 })).toEqual({ x: 2, y: 0 });
  });

  it("한글은 한 글자에 두 칸으로 센다", () => {
    expect(inputCursorOffset({ collectedLines: [], textBeforeCursor: "안녕", columns: 80 })).toEqual({ x: 6, y: 0 });
  });

  it("이어 받은 줄 수만큼 아래로 내려가고 이어 받기 프롬프트 뒤에 둔다", () => {
    expect(inputCursorOffset({ collectedLines: ["첫 줄", "둘째"], textBeforeCursor: "ab", columns: 80 })).toEqual({
      x: 4,
      y: 2,
    });
  });

  it("터미널 폭을 넘으면 감긴 행으로 옮긴다", () => {
    expect(inputCursorOffset({ collectedLines: [], textBeforeCursor: "abcdefghij", columns: 10 })).toEqual({ x: 2, y: 1 });
  });

  it("감긴 이어 받은 줄은 감긴 행 수만큼 센다", () => {
    expect(inputCursorOffset({ collectedLines: ["가나다라마바"], textBeforeCursor: "", columns: 10 })).toEqual({
      x: 2,
      y: 2,
    });
  });

  it("붙여넣은 줄바꿈 뒤에서는 프롬프트 없이 줄 첫 칸부터 센다", () => {
    expect(inputCursorOffset({ collectedLines: [], textBeforeCursor: "ab\ncd", columns: 80 })).toEqual({ x: 2, y: 1 });
  });
});

describe("StatusBar", () => {
  it("잔액을 모르면 잔액 부분만 뺀다", () => {
    const { lastFrame } = render(<StatusBar model="claude-test" permissionMode="plan" sessionCostUsd={0.0123} />);

    expect(plainFrame(lastFrame)).toContain("claude-test · plan · 세션 $0.0123");
    expect(plainFrame(lastFrame)).not.toContain("크레딧");
  });

  it("모델·모드·비용·잔액을 표시한다", () => {
    const { lastFrame } = render(
      <StatusBar model="claude-test" permissionMode="plan" sessionCostUsd={0.0123} remainingCreditUsd={99.5} />,
    );

    expect(plainFrame(lastFrame)).toContain("claude-test · plan · 세션 $0.0123 · 크레딧 잔여 추정 $99.50");
  });
});

describe("App", () => {
  it("시작 잔액을 읽어 상태 줄을 그리고, permission_mode 이벤트 뒤 새 모드로 바꾼다", async () => {
    const { session, frame } = renderApp();

    await vi.waitFor(() => expect(frame()).toContain("claude-test · default · 세션 $0.0000 · 크레딧 잔여 추정 $99.50"));
    session.currentPermissionMode = "plan";
    session.emit({ type: "permission_mode", mode: "plan" });

    await vi.waitFor(() => expect(frame()).toContain("claude-test · plan · 세션"));
  });

  it("시작 잔액을 읽지 못해도 잔액만 빼고 상태 줄을 그린다", async () => {
    const { frame } = renderApp({
      readUsage: async () => {
        throw new Error("읽기 실패");
      },
    });

    await vi.waitFor(() => expect(frame()).toContain("오류: 사용량을 읽지 못했습니다: 읽기 실패"));
    expect(frame()).toContain("claude-test · default · 세션 $0.0000");
    expect(frame()).not.toContain("크레딧 잔여 추정");
  });

  it("turn_result마다 recordUsage 결과로 잔액을 갱신한다", async () => {
    const recordUsage = vi.fn(async (_costUsd: number) => ({ startingCreditUsd: 100, spentUsd: 10 }));
    const { session, frame } = renderApp({ recordUsage });

    session.totalCostUsd = 0.25;
    session.emit({ type: "turn_result", costUsd: 0.25, totalCostUsd: 0.25, isError: false });

    await vi.waitFor(() => expect(frame()).toContain("세션 $0.2500 · 크레딧 잔여 추정 $90.00"));
    expect(recordUsage).toHaveBeenCalledWith(0.25);
  });

  it("recordUsage가 실패하면 오류 notice를 보인다", async () => {
    const recordUsage = vi.fn(async (): Promise<UsageSnapshot> => {
      throw new Error("디스크 가득");
    });
    const { session, frame } = renderApp({ recordUsage });

    session.emit({ type: "turn_result", costUsd: 0.01, totalCostUsd: 0.01, isError: false });

    await vi.waitFor(() => expect(frame()).toContain("오류: 사용량을 기록하지 못했습니다: 디스크 가득"));
  });

  it("prompt 입력은 session.send로, 명령은 runCommand로 처리한다", async () => {
    const { stdin, session, frame } = renderApp();

    await press(stdin, "안녕");
    await press(stdin, ENTER);
    expect(session.sent).toEqual(["안녕"]);
    await press(stdin, "/mode");
    await press(stdin, ENTER);

    await vi.waitFor(() => expect(frame()).toContain("현재 모드: default"));
    expect(session.sent).toEqual(["안녕"]);
  });

  it("Shift+Tab은 다음 권한 모드로 바꾼다", async () => {
    const { stdin, session } = renderApp();
    session.currentPermissionMode = "acceptEdits";

    await press(stdin, SHIFT_TAB);

    expect(session.setPermissionMode).toHaveBeenCalledWith("plan");
  });

  it("권한 모드 변경이 실패하면 오류 notice를 보인다", async () => {
    const { stdin, session, frame } = renderApp();
    session.setPermissionMode.mockRejectedValueOnce(new Error("세션이 이미 종료되었습니다"));

    await press(stdin, SHIFT_TAB);

    await vi.waitFor(() => expect(frame()).toContain("오류: 세션이 이미 종료되었습니다"));
  });

  it("대화상자가 떠 있으면 Shift+Tab을 무시한다", async () => {
    const { stdin, session, store, frame } = renderApp();
    void store.prompter({ toolName: "Bash", summary: "ls" });
    await vi.waitFor(() => expect(frame()).toContain("Bash(ls) 허용할까요?"));

    await press(stdin, SHIFT_TAB);

    expect(session.setPermissionMode).not.toHaveBeenCalled();
  });

  it("권한 요청 두 개는 첫 응답 뒤에 두 번째 대화상자를 보인다", async () => {
    const { stdin, store, frame } = renderApp();

    const first = store.prompter({ toolName: "Bash", summary: "first" });
    const second = store.prompter({ toolName: "Bash", summary: "second" });
    await vi.waitFor(() => expect(frame()).toContain("Bash(first) 허용할까요?"));
    expect(frame()).not.toContain("Bash(second) 허용할까요?");
    await press(stdin, "y");

    await expect(first).resolves.toBe("allow");
    await vi.waitFor(() => expect(frame()).toContain("Bash(second) 허용할까요?"));
    expect(frame()).not.toContain("Bash(first) 허용할까요?");
    await press(stdin, "n");
    await expect(second).resolves.toBe("deny");
  });

  it("대화상자의 답은 입력창에 섞이지 않는다", async () => {
    const { stdin, store, session, frame } = renderApp();

    const decision = store.prompter({ toolName: "Bash", summary: "ls" });
    await vi.waitFor(() => expect(frame()).toContain("허용할까요?"));
    await press(stdin, "y");
    await expect(decision).resolves.toBe("allow");
    await press(stdin, ENTER);

    expect(session.sent).toEqual([]);
  });

  it("SDK가 요청을 취소하면 대화상자를 닫고 deny", async () => {
    const { store, frame } = renderApp();
    const controller = new AbortController();

    const decision = store.prompter({ toolName: "Bash", summary: "ls", signal: controller.signal });
    await vi.waitFor(() => expect(frame()).toContain("허용할까요?"));
    controller.abort();

    await expect(decision).resolves.toBe("deny");
    await vi.waitFor(() => expect(frame()).not.toContain("허용할까요?"));
  });

  it("계획 요청은 진행 중 응답을 확정하고 계획 본문을 대화 영역에 보인 뒤 묻는다", async () => {
    const { stdin, store, session, frame } = renderApp();
    session.emit({ type: "text_delta", text: "진행 중 응답" });
    await vi.waitFor(() => expect(frame()).toContain("진행 중 응답"));

    const decision = store.prompter({ toolName: "ExitPlanMode", summary: "", plan: { text: "## 계획 본문\n- 단계 하나" } });

    await vi.waitFor(() => expect(frame()).toContain("계획을 승인할까요?"));
    expect(store.getSnapshot().transcript.streaming).toBeUndefined();
    const text = frame();
    expect(text).toContain("계획 본문");
    expect(text).toContain("• 단계 하나");
    expect(text.indexOf("계획 본문")).toBeLessThan(text.indexOf("계획을 승인할까요?"));
    await press(stdin, "e");
    await expect(decision).resolves.toBe("allowAcceptEdits");
  });

  it("대화상자에서 Ctrl+C는 deny하고 턴을 중단한다", async () => {
    const { stdin, store, session } = renderApp();
    session.isBusy = true;

    const decision = store.prompter({ toolName: "Bash", summary: "ls" });
    await vi.waitFor(() => expect(store.getSnapshot().dialog).toBeDefined());
    await press(stdin, CTRL_C);

    await expect(decision).resolves.toBe("deny");
    expect(session.interrupt).toHaveBeenCalledTimes(1);
  });

  it("대화상자에서 Esc는 deny만 하고 턴을 중단하지 않는다", async () => {
    const { stdin, store, session } = renderApp();
    session.isBusy = true;

    const decision = store.prompter({ toolName: "Bash", summary: "ls" });
    await vi.waitFor(() => expect(store.getSnapshot().dialog).toBeDefined());
    stdin.write(ESCAPE);

    await expect(decision).resolves.toBe("deny");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(session.interrupt).not.toHaveBeenCalled();
  });

  it("실행 중 Esc는 턴을 중단하고 (중단됨)을 보인다", async () => {
    const { stdin, session, frame } = renderApp();
    session.isBusy = true;

    stdin.write(ESCAPE);

    await vi.waitFor(() => expect(frame()).toContain("(중단됨)"));
    expect(session.interrupt).toHaveBeenCalledTimes(1);
  });

  it("실행 중 Ctrl+C는 턴을 중단한다", async () => {
    const { stdin, session, frame } = renderApp();
    session.isBusy = true;

    await press(stdin, CTRL_C);

    expect(session.interrupt).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(frame()).toContain("(중단됨)"));
  });

  it("대기 중 Ctrl+C는 안내를 보이고, 2초 안에 한 번 더 누르면 종료한다", async () => {
    const { stdin, session, frame, onClosed } = renderApp();

    await press(stdin, CTRL_C);
    await vi.waitFor(() => expect(frame()).toContain("한 번 더 누르면 종료합니다"));
    expect(session.close).not.toHaveBeenCalled();
    await press(stdin, CTRL_C);

    expect(session.close).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(frame()).toContain("세션 ID: s1"));
  });

  it("Ctrl+D는 종료한다", async () => {
    const { stdin, session } = renderApp();

    await press(stdin, CTRL_D);

    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("입력 중인 글자가 있으면 Ctrl+D를 무시한다", async () => {
    const { stdin, session } = renderApp();

    await press(stdin, "abc");
    await press(stdin, CTRL_D);

    expect(session.close).not.toHaveBeenCalled();
  });

  it("turn_result 뒤의 이벤트는 사용량 기록이 끝난 뒤에 처리한다", async () => {
    let finishRecord: (snapshot: UsageSnapshot) => void = () => undefined;
    const recordUsage = vi.fn(
      () =>
        new Promise<UsageSnapshot>((resolve) => {
          finishRecord = resolve;
        }),
    );
    const { session, frame } = renderApp({ recordUsage });

    session.emit({ type: "turn_result", costUsd: 0.01, totalCostUsd: 0.01, isError: false });
    session.emit({ type: "error", message: "다음 오류" });
    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(frame()).not.toContain("다음 오류");
    finishRecord(SNAPSHOT);

    await vi.waitFor(() => expect(frame()).toContain("다음 오류"));
  });
});

describe("createInkUi", () => {
  function createStreams() {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
    const state = { written: "" };
    stdout.on("data", (chunk: Buffer) => {
      state.written += chunk.toString();
    });
    return {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      output: () => stripVTControlCharacters(state.written),
    };
  }

  // Ink는 console.Console로 console을 감싸는데, vitest의 console에는 Console이 없다.
  beforeEach(() => {
    Object.defineProperty(console, "Console", { value: Console, configurable: true });
  });

  afterEach(() => {
    Reflect.deleteProperty(console, "Console");
  });

  it("run은 session을 시작하고, session_closed가 오면 화면을 닫고 끝난다", async () => {
    const { stdin, stdout, output } = createStreams();
    const session = new FakeSession();
    const ui = createInkUi({ stdin, stdout });

    const running = ui.run(session.asSession(), {
      commandContext: { session: session.asSession(), readUsage: async () => SNAPSHOT },
      recordUsage: async () => SNAPSHOT,
    });
    expect(session.start).toHaveBeenCalledTimes(1);
    await session.close();

    await expect(running).resolves.toBeUndefined();
    expect(output()).toContain("세션 ID: s1");
  });

  it("터미널에서는 실제 커서를 입력창 커서 칸에 보여 한글 IME 조합 글자가 입력창에 뜬다", async () => {
    // 화면은 빈 줄, "> 안녕", 상태 줄이다. 맨 아래에서 두 줄 올라가 "> 안녕"(폭 6) 다음 칸(7열)에 커서를 보인다.
    const CURSOR_AFTER_INPUT = "\u001b[2A\u001b[7G\u001b[?25h";
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    let written = "";
    stdout.on("data", (chunk: Buffer) => {
      written += chunk.toString();
    });
    const session = new FakeSession();
    const ui = createInkUi({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    const running = ui.run(session.asSession(), {
      commandContext: { session: session.asSession(), readUsage: async () => SNAPSHOT },
      recordUsage: async () => SNAPSHOT,
    });
    stdin.write("안녕");

    await vi.waitFor(() => expect(written).toContain(CURSOR_AFTER_INPUT));
    await session.close();
    await running;
  });
});
