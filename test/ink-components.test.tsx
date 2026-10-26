import { Console } from "node:console";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../src/session.js";
import type { PermissionDecision, PermissionRequest, UiEvent, UserQuestion } from "../src/types.js";
import type { UsageSnapshot } from "../src/usageStore.js";
import { App, InkUiStore, connectSession } from "../src/ui/ink/App.js";
import { InputBox, inputCursorOffset } from "../src/ui/ink/InputBox.js";
import { PermissionDialog } from "../src/ui/ink/PermissionDialog.js";
import { QuestionDialog } from "../src/ui/ink/QuestionDialog.js";
import { SessionPicker } from "../src/ui/ink/SessionPicker.js";
import type { SessionListItem } from "../src/sessionList.js";
import { StatusBar } from "../src/ui/ink/StatusBar.js";
import { Transcript } from "../src/ui/ink/TranscriptView.js";
import { createInkUi } from "../src/ui/ink/index.js";
import type { TranscriptState } from "../src/ui/ink/transcript.js";
import { addNotice, addUserInput, initialTranscript, reduceTranscript } from "../src/ui/ink/transcript.js";
import type { UiRunOptions } from "../src/ui/runOptions.js";
import { HISTORY_HEADER } from "../src/ui/plain.js";

const ENTER = "\r";
const ESCAPE = "\u001b";
const UP = "\u001b[A";
const DOWN = "\u001b[B";
const SHIFT_TAB = "\u001b[Z";
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const SPACE = " ";
/** kitty keyboard protocol의 Shift+Enter. */
const SHIFT_ENTER = "\u001b[13;2u";
/** Option(Esc+)+Enter. */
const META_ENTER = "\u001b\r";

const SINGLE_QUESTION: UserQuestion = {
  question: "어떤 방식으로 할까요?",
  header: "방식",
  multiSelect: false,
  options: [
    { label: "A안", description: "빠름" },
    { label: "B안", description: "안전함" },
  ],
};

const MULTI_QUESTION: UserQuestion = {
  question: "어떤 기능을 켤까요?",
  header: "기능",
  multiSelect: true,
  options: [
    { label: "로그", description: "기록" },
    { label: "알림", description: "통지" },
    { label: "통계", description: "집계" },
  ],
};

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
  readonly replace = vi.fn(async (_resume?: string) => undefined);

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
  overrides: {
    recordUsage?: UiRunOptions["recordUsage"];
    readUsage?: UiRunOptions["commandContext"]["readUsage"];
    listSessions?: UiRunOptions["commandContext"]["listSessions"];
    startupCommand?: string;
  } = {},
) {
  const session = new FakeSession();
  const store = new InkUiStore();
  const recordUsage = overrides.recordUsage ?? vi.fn(async (_costUsd: number) => SNAPSHOT);
  const options: UiRunOptions = {
    commandContext: {
      session: session.asSession(),
      readUsage: overrides.readUsage ?? (async () => SNAPSHOT),
      ...(overrides.listSessions === undefined ? {} : { listSessions: overrides.listSessions }),
    },
    recordUsage,
  };
  const onClosed = vi.fn();
  connectSession(store, session.asSession(), options, onClosed);
  const view = render(
    <App
      store={store}
      session={session.asSession()}
      commandContext={options.commandContext}
      initialHistory={[]}
      {...(overrides.startupCommand === undefined ? {} : { startupCommand: overrides.startupCommand })}
    />,
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

  it("history 항목은 머리말 아래에 이전 대화 줄을 그린다", () => {
    const state = reduceTranscript(initialTranscript, { type: "history", lines: ["> 이전 입력", "", "이전 응답"] });

    const { lastFrame } = render(<Transcript state={state} />);
    const text = plainFrame(lastFrame);

    expect(text).toContain(`${HISTORY_HEADER}\n> 이전 입력\n\n이전 응답`);
  });

  describe("진행 표시 줄", () => {
    const editStart: UiEvent = {
      type: "tool_start",
      toolUseId: "t1",
      name: "Edit",
      summary: "a.ts",
      input: { file_path: "a.ts", old_string: "old line", new_string: "new line" },
    };

    // done(Static)을 비우면 동적 영역만 남는다.
    function dynamicLines(state: TranscriptState): string[] {
      const { lastFrame } = render(<Transcript state={{ ...state, done: [] }} />);
      return plainFrame(lastFrame).split("\n");
    }

    it("응답이 나오는 동안에도 동적 영역 높이가 같아 상태 줄이 움직이지 않는다", () => {
      const idle = initialTranscript;
      const streaming = reduceTranscript(idle, { type: "text_delta", text: "진행 중" });
      const lineDone = reduceTranscript(streaming, { type: "text_delta", text: "\n" });
      const toolRunning = reduceTranscript(idle, editStart);

      const heights = [idle, streaming, lineDone, toolRunning].map((state) => dynamicLines(state).length);

      expect(new Set(heights).size).toBe(1);
    });

    it("끝나지 않은 응답 줄이 실행 중 표시보다 먼저 보인다", () => {
      let state = reduceTranscript(initialTranscript, editStart);
      state = reduceTranscript(state, { type: "text_delta", text: "완성 줄\n진행 중" });

      expect(dynamicLines(state).filter((line) => line.trim() !== "")).toEqual(["진행 중"]);
    });

    it("응답 줄이 없으면 실행 중인 도구를 보이고, 여럿이면 나머지 개수를 붙인다", () => {
      let state = reduceTranscript(initialTranscript, editStart);
      expect(dynamicLines(state).filter((line) => line.trim() !== "")).toEqual(["⏺ Edit(a.ts) 실행 중…"]);

      state = reduceTranscript(state, { type: "tool_start", toolUseId: "t2", name: "Bash", summary: "ls", input: {} });
      expect(dynamicLines(state).filter((line) => line.trim() !== "")).toEqual(["⏺ Edit(a.ts) 실행 중… 외 1개"]);
    });

    it("폭을 넘는 응답 줄은 끝부분만 한 줄로 보인다", () => {
      const longLine = `${"가".repeat(200)}끝부분`;
      const state = reduceTranscript(initialTranscript, { type: "text_delta", text: longLine });

      const visible = dynamicLines(state).filter((line) => line.trim() !== "");

      expect(visible).toHaveLength(1);
      expect(visible[0]).toContain("끝부분");
    });
  });

  it("diff의 바뀐 줄은 배경이 터미널 폭 끝까지 깔린다", () => {
    vi.stubEnv("FORCE_COLOR", "1");
    vi.stubEnv("NO_COLOR", "");
    const state = reduceTranscript(initialTranscript, {
      type: "tool_start",
      toolUseId: "t1",
      name: "Edit",
      summary: "a.ts",
      input: { file_path: "a.ts", old_string: "old line", new_string: "new line" },
    });

    const { lastFrame, stdout } = render(<Transcript state={{ ...state, running: [] }} />);
    const addedLine = (lastFrame() ?? "").split("\n").find((line) => line.includes("+ new line")) ?? "";
    vi.unstubAllEnvs();

    expect(addedLine).toContain("\u001b[48;5;22m");
    expect(stripVTControlCharacters(addedLine)).toHaveLength(stdout.columns);
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

describe("QuestionDialog", () => {
  function renderQuestion(question: UserQuestion, typing = false) {
    const onAnswer = vi.fn((_answer: string) => undefined);
    const onStartTyping = vi.fn();
    const onStopTyping = vi.fn();
    const onCancel = vi.fn();
    const view = render(
      <QuestionDialog
        question={question}
        index={0}
        total={2}
        typing={typing}
        onAnswer={onAnswer}
        onStartTyping={onStartTyping}
        onStopTyping={onStopTyping}
        onCancel={onCancel}
      />,
    );
    return { ...view, onAnswer, onStartTyping, onStopTyping, onCancel, frame: () => plainFrame(view.lastFrame) };
  }

  it("질문 머리줄, 번호 붙은 선택지와 설명, 직접 입력을 보인다", () => {
    const text = renderQuestion(SINGLE_QUESTION).frame();

    expect(text).toContain("[1/2 방식] 어떤 방식으로 할까요?");
    expect(text).toContain("❯ 1. A안 — 빠름");
    expect(text).toContain("  2. B안 — 안전함");
    expect(text).toContain("  3. 직접 입력");
  });

  it("단일 선택: 숫자 키는 바로 답하고, ↓·Enter는 고른 선택지로 답한다", async () => {
    const digit = renderQuestion(SINGLE_QUESTION);
    await press(digit.stdin, "2");
    expect(digit.onAnswer).toHaveBeenCalledWith("B안");

    const arrow = renderQuestion(SINGLE_QUESTION);
    await press(arrow.stdin, DOWN);
    await press(arrow.stdin, ENTER);
    expect(arrow.onAnswer).toHaveBeenCalledWith("B안");
  });

  it("복수 선택: Space·숫자로 체크하고 Enter는 체크한 것을 선택지 순서로 잇는다", async () => {
    const { stdin, onAnswer, frame } = renderQuestion(MULTI_QUESTION);

    await press(stdin, SPACE);
    await press(stdin, "3");
    expect(frame()).toContain("[x] 1. 로그");
    expect(frame()).toContain("[x] 3. 통계");
    expect(frame()).toContain("[ ] 2. 알림");
    await press(stdin, ENTER);

    expect(onAnswer).toHaveBeenCalledWith("로그, 통계");
  });

  it("복수 선택에서 아무것도 체크하지 않고 Enter면 고른 선택지 하나로 답한다", async () => {
    const { stdin, onAnswer } = renderQuestion(MULTI_QUESTION);

    await press(stdin, DOWN);
    await press(stdin, ENTER);

    expect(onAnswer).toHaveBeenCalledWith("알림");
  });

  it("직접 입력에서 Enter는 입력 모드로 바꾸고, Esc는 취소한다", async () => {
    const typing = renderQuestion(SINGLE_QUESTION);
    await press(typing.stdin, "3");
    expect(typing.onStartTyping).toHaveBeenCalled();
    expect(typing.onAnswer).not.toHaveBeenCalled();

    const cancel = renderQuestion(SINGLE_QUESTION);
    await press(cancel.stdin, ESCAPE);
    expect(cancel.onCancel).toHaveBeenCalled();
  });

  it("입력 모드에서는 안내를 보이고, 숫자 키는 무시하며 Esc는 선택지로 돌아간다", async () => {
    const { stdin, onAnswer, onStopTyping, onCancel, frame } = renderQuestion(SINGLE_QUESTION, true);

    expect(frame()).toContain("입력창에 답을 쓰고 Enter");
    await press(stdin, "1");
    await press(stdin, ESCAPE);

    expect(onAnswer).not.toHaveBeenCalled();
    expect(onStopTyping).toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

function sessionItems(count: number): SessionListItem[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => ({
    sessionId: `id-${index + 1}`,
    title: `작업 ${index + 1}`,
    lastModified: now - (index + 1) * 3_600_000,
  }));
}

describe("SessionPicker", () => {
  function renderPicker(items: SessionListItem[]) {
    const onPick = vi.fn((_sessionId: string) => undefined);
    const onCancel = vi.fn();
    const view = render(<SessionPicker items={items} onPick={onPick} onCancel={onCancel} />);
    return { ...view, onPick, onCancel, frame: () => plainFrame(view.lastFrame) };
  }

  it("제목 아래에 마지막 대화 시간을 보이고 첫 항목을 고른 상태로 시작한다", () => {
    const text = renderPicker(sessionItems(2)).frame();

    expect(text).toContain("이어서 열 세션 (최신순) 1/2");
    expect(text).toMatch(/❯ 작업 1 [^\n]*\n[^\n]* \d+\/\d{2} \d{2}:\d{2} · 1시간 전/);
    expect(text).toMatch(/ {2}작업 2 [^\n]*\n[^\n]* · 2시간 전/);
  });

  it("↓·Enter는 고른 세션 ID를, Esc는 취소를 알린다", async () => {
    const pick = renderPicker(sessionItems(3));
    await press(pick.stdin, DOWN);
    await press(pick.stdin, ENTER);
    expect(pick.onPick).toHaveBeenCalledWith("id-2");

    const cancel = renderPicker(sessionItems(3));
    await press(cancel.stdin, ESCAPE);
    expect(cancel.onCancel).toHaveBeenCalled();
  });

  it("목록이 길면 고른 항목이 보이도록 창을 옮긴다", async () => {
    const { stdin, frame } = renderPicker(sessionItems(20));
    expect(frame()).not.toContain("작업 15");

    for (let step = 0; step < 14; step++) {
      await press(stdin, DOWN);
    }

    expect(frame()).toContain("❯ 작업 15");
    expect(frame()).toContain("15/20");
    expect(frame()).not.toMatch(/작업 1 /);
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

  it("긴 입력은 단어가 아니라 글자 단위로 줄을 넘겨 커서 계산과 맞춘다", async () => {
    const { stdin, frame } = renderInput();
    // 테스트 화면 폭은 100칸. 단어 단위로 넘기면 첫 줄이 공백에서 끊겨 100칸을 채우지 못한다.
    // "> "(2칸) + "가나다 라마 "(12칸)×8 = 98칸, 다음 "가"까지 100칸. 단어 단위면 "가나다"째 다음 줄로 간다.
    const text = "가나다 라마 ".repeat(10);

    await press(stdin, text);

    const [firstRow = "", secondRow = ""] = frame().split("\n");
    expect(stringWidth(firstRow)).toBe(100);
    expect(firstRow.endsWith("라마 가")).toBe(true);
    expect(secondRow.startsWith("나다 라마")).toBe(true);
  });

  it("Shift+Enter는 제출하지 않고 줄을 바꾸며, Enter로 여러 줄을 한 번에 보낸다", async () => {
    const { stdin, onSubmit, onHistoryChange, frame } = renderInput();

    await press(stdin, "첫 줄");
    await press(stdin, SHIFT_ENTER);
    await press(stdin, "둘째 줄");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(frame()).toContain("> 첫 줄\n둘째 줄");
    await press(stdin, ENTER);

    expect(onSubmit).toHaveBeenCalledWith("첫 줄\n둘째 줄");
    expect(onHistoryChange).toHaveBeenLastCalledWith(["첫 줄\n둘째 줄"]);
  });

  it("여러 줄 입력도 ↑로 다시 불러와 그대로 보낼 수 있다", async () => {
    const { stdin, onSubmit, frame } = renderInput(["a\nb"]);

    await press(stdin, UP);
    expect(frame()).toContain("> a\nb");
    await press(stdin, ENTER);

    expect(onSubmit).toHaveBeenCalledWith("a\nb");
  });

  it("줄 끝 \\로 이어 받은 입력은 줄마다가 아니라 완성된 입력 하나로 기록한다", async () => {
    const { stdin, onHistoryChange } = renderInput();

    await press(stdin, "a\\");
    await press(stdin, ENTER);
    await press(stdin, "b");
    await press(stdin, ENTER);

    expect(onHistoryChange).toHaveBeenCalledTimes(1);
    expect(onHistoryChange).toHaveBeenLastCalledWith(["a\nb"]);
  });

  it("Option+Enter도 줄을 바꾼다", async () => {
    const { stdin, onSubmit } = renderInput();

    await press(stdin, "a");
    await press(stdin, META_ENTER);
    await press(stdin, "b");
    await press(stdin, ENTER);

    expect(onSubmit).toHaveBeenCalledWith("a\nb");
  });

  it("여러 줄 입력이 아니면 Ctrl+C는 onInterrupt를 부른다", async () => {
    const { stdin, onInterrupt } = renderInput();

    await press(stdin, CTRL_C);

    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });
});

describe("inputCursorOffset", () => {
  it("넓은 글자가 줄 끝 남은 한 칸에 들어가지 않으면 다음 줄 첫 칸부터 센다", () => {
    // "> a"(3칸) + 가×13(26칸) = 29칸. 14번째 가는 남은 1칸에 들어가지 않아 다음 줄로 넘어간다.
    expect(inputCursorOffset({ collectedLines: [], textBeforeCursor: `a${"가".repeat(14)}`, columns: 30 })).toEqual({
      x: 2,
      y: 1,
    });
  });

  it("줄을 꽉 채우면 다음 줄 첫 칸", () => {
    expect(inputCursorOffset({ collectedLines: [], textBeforeCursor: "가".repeat(14), columns: 30 })).toEqual({
      x: 0,
      y: 1,
    });
  });

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

  it("kitty keyboard protocol 형식의 Shift+Tab·Esc·Ctrl+C도 같은 동작을 한다", async () => {
    const { stdin, session } = renderApp();
    session.currentPermissionMode = "acceptEdits";
    await press(stdin, "\u001b[9;2u");
    expect(session.setPermissionMode).toHaveBeenCalledWith("plan");

    session.isBusy = true;
    await press(stdin, "\u001b[27u");
    expect(session.interrupt).toHaveBeenCalledTimes(1);
    await press(stdin, "\u001b[99;5u");
    expect(session.interrupt).toHaveBeenCalledTimes(2);
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

  describe("세션 고르기", () => {
    it("/resume은 목록 창을 띄우고 고른 세션으로 이동한다", async () => {
      const { stdin, store, session, frame } = renderApp({ listSessions: async () => sessionItems(3) });

      await press(stdin, "/resume");
      await press(stdin, ENTER);
      await vi.waitFor(() => expect(frame()).toContain("이어서 열 세션"));
      await press(stdin, DOWN);
      await press(stdin, ENTER);

      await vi.waitFor(() => expect(session.replace).toHaveBeenCalledWith("id-2"));
      expect(store.getSnapshot().picker).toBeUndefined();
      expect(session.sent).toEqual([]);
    });

    it("startupCommand가 있으면 시작하자마자 실행하고, Esc는 취소한다", async () => {
      const { stdin, session, frame } = renderApp({ listSessions: async () => sessionItems(2), startupCommand: "/resume" });

      await vi.waitFor(() => expect(frame()).toContain("이어서 열 세션"));
      await press(stdin, ESCAPE);

      await vi.waitFor(() => expect(frame()).toContain("세션 선택을 취소했습니다"));
      expect(session.replace).not.toHaveBeenCalled();
    });

    it("Ctrl+C는 목록 창을 닫는다", async () => {
      const { stdin, store } = renderApp({ listSessions: async () => sessionItems(2) });

      await press(stdin, "/resume");
      await press(stdin, ENTER);
      await vi.waitFor(() => expect(store.getSnapshot().picker).toBeDefined());
      await press(stdin, CTRL_C);

      await vi.waitFor(() => expect(store.getSnapshot().picker).toBeUndefined());
    });
  });

  describe("AskUserQuestion", () => {
    it("질문을 차례로 묻고 답을 돌려준 뒤 대화 영역에 요약을 남긴다", async () => {
      const { stdin, store, session, frame } = renderApp();

      const answers = store.asker({ questions: [SINGLE_QUESTION, MULTI_QUESTION] });
      await vi.waitFor(() => expect(frame()).toContain("[1/2 방식] 어떤 방식으로 할까요?"));
      await press(stdin, "2");
      await vi.waitFor(() => expect(frame()).toContain("[2/2 기능] 어떤 기능을 켤까요?"));
      await press(stdin, "1");
      await press(stdin, "3");
      await press(stdin, ENTER);

      await expect(answers).resolves.toEqual({ "어떤 방식으로 할까요?": "B안", "어떤 기능을 켤까요?": "로그, 통계" });
      await vi.waitFor(() => expect(frame()).toContain("방식: B안\n기능: 로그, 통계"));
      expect(frame()).not.toContain("어떤 기능을 켤까요?");
      expect(session.sent).toEqual([]);
    });

    it("직접 입력을 고르면 입력창으로 답을 받고 SDK로 보내지 않는다", async () => {
      const { stdin, store, session } = renderApp();

      const answers = store.asker({ questions: [SINGLE_QUESTION] });
      await vi.waitFor(() => expect(store.getSnapshot().question).toBeDefined());
      await press(stdin, "3");
      await vi.waitFor(() => expect(store.getSnapshot().question?.typing).toBe(true));
      await press(stdin, "C안으로");
      await press(stdin, ENTER);

      await expect(answers).resolves.toEqual({ "어떤 방식으로 할까요?": "C안으로" });
      expect(session.sent).toEqual([]);
    });

    it("Esc로 취소하면 undefined", async () => {
      const { stdin, store } = renderApp();

      const answers = store.asker({ questions: [SINGLE_QUESTION] });
      await vi.waitFor(() => expect(store.getSnapshot().question).toBeDefined());
      await press(stdin, ESCAPE);

      await expect(answers).resolves.toBeUndefined();
      expect(store.getSnapshot().question).toBeUndefined();
    });

    it("Ctrl+C는 질문을 취소하고 턴을 중단한다 (입력 모드에서도)", async () => {
      const { stdin, store, session } = renderApp();
      session.isBusy = true;

      const choosing = store.asker({ questions: [SINGLE_QUESTION] });
      await vi.waitFor(() => expect(store.getSnapshot().question).toBeDefined());
      await press(stdin, CTRL_C);
      await expect(choosing).resolves.toBeUndefined();
      expect(session.interrupt).toHaveBeenCalledTimes(1);

      const typing = store.asker({ questions: [SINGLE_QUESTION] });
      await vi.waitFor(() => expect(store.getSnapshot().question).toBeDefined());
      await press(stdin, "3");
      await press(stdin, CTRL_C);
      await expect(typing).resolves.toBeUndefined();
      expect(session.interrupt).toHaveBeenCalledTimes(2);
    });

    it("SDK가 취소하면 질문 창을 닫고 undefined", async () => {
      const { store } = renderApp();
      const controller = new AbortController();

      const answers = store.asker({ questions: [SINGLE_QUESTION], signal: controller.signal });
      await vi.waitFor(() => expect(store.getSnapshot().question).toBeDefined());
      controller.abort();

      await expect(answers).resolves.toBeUndefined();
      expect(store.getSnapshot().question).toBeUndefined();
    });

    it("권한 질문이 떠 있으면 그 답 뒤에 질문 창을 띄운다", async () => {
      const { stdin, store, frame } = renderApp();

      const decision = store.prompter({ toolName: "Bash", summary: "ls" });
      const answers = store.asker({ questions: [SINGLE_QUESTION] });
      await vi.waitFor(() => expect(frame()).toContain("허용할까요?"));
      expect(store.getSnapshot().question).toBeUndefined();
      await press(stdin, "y");
      await expect(decision).resolves.toBe("allow");
      await vi.waitFor(() => expect(store.getSnapshot().question).toBeDefined());
      await press(stdin, "1");

      await expect(answers).resolves.toEqual({ "어떤 방식으로 할까요?": "A안" });
    });
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

  it("터미널에 kitty keyboard protocol 지원 여부를 묻는다 (Shift+Enter 구분용)", async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true });
    let written = "";
    stdout.on("data", (chunk: Buffer) => {
      written += chunk.toString();
    });
    const session = new FakeSession();
    const ui = createInkUi({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream });

    const running = ui.run(session.asSession(), {
      commandContext: { session: session.asSession(), readUsage: async () => SNAPSHOT },
      recordUsage: async () => SNAPSHOT,
    });
    await vi.waitFor(() => expect(written).toContain("\u001b[?u"));
    await session.close();
    await running;
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
