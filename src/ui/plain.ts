import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface, emitKeypressEvents } from "node:readline";
import { styleText } from "node:util";
import { parseInput, runCommand } from "../commands.js";
import type { CommandContext } from "../commands.js";
import { formatToolDiff } from "../diffView.js";
import { createMarkdownRenderer } from "../markdown.js";
import type { Session } from "../session.js";
import type { PermissionDecision, PermissionPrompter, UiEvent } from "../types.js";
import { remainingCreditUsd } from "../usageStore.js";
import type { UsageSnapshot } from "../usageStore.js";

const PROMPT = "> ";
const CONTINUATION_PROMPT = "… ";
const HISTORY_SIZE = 500;
const EXIT_CONFIRM_WINDOW_MS = 2000;
const CREDIT_HINT = "프로모션 크레딧이 소진되었거나 만료되었을 수 있습니다 (Console › Billing 확인)";

export interface PlainUiIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** 기본값은 input이 TTY인지 여부. */
  terminal?: boolean;
  /** 입력 기록 파일. 첫 줄이 가장 최근 입력이다. */
  historyFile?: string;
}

export interface PlainRunOptions {
  commandContext: CommandContext;
  recordUsage: (costUsd: number) => Promise<UsageSnapshot>;
}

export interface PlainUi {
  prompter: PermissionPrompter;
  run(session: Session, options: PlainRunOptions): Promise<void>;
}

/** 줄 끝의 \\로 이어지는 여러 줄 입력을 모은다. */
export class MultilineBuffer {
  private readonly lines: string[] = [];

  /** 입력이 완성되면 모은 줄을 \\n으로 이어 돌려주고, 이어지는 중이면 undefined. */
  push(line: string): string | undefined {
    if (line.endsWith("\\")) {
      this.lines.push(line.slice(0, -1));
      return undefined;
    }
    const text = [...this.lines, line].join("\n");
    this.reset();
    return text;
  }

  reset(): void {
    this.lines.length = 0;
  }

  get isCollecting(): boolean {
    return this.lines.length > 0;
  }
}

export function formatStatusLine(params: { model?: string; sessionCostUsd: number; remainingCreditUsd: number }): string {
  const model = params.model ?? "기본 모델";
  const text = `${model} · 세션 ${usd(params.sessionCostUsd)} · 크레딧 잔여 추정 $${params.remainingCreditUsd.toFixed(2)}`;
  return styleText("dim", text);
}

function usd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

export function parseDecision(answer: string): PermissionDecision | undefined {
  switch (answer.trim().toLowerCase()) {
    case "y":
    case "yes":
      return "allow";
    case "n":
    case "no":
      return "deny";
    case "a":
    case "always":
      return "always";
    default:
      return undefined;
  }
}

export function formatEvent(event: UiEvent): string {
  switch (event.type) {
    case "session_start":
      return `${styleText("dim", `claud3 · API key(${event.apiKeySource}) · Agent SDK · ${event.model}`)}\n`;
    case "text_delta":
      return event.text;
    case "tool_start": {
      const diff = formatToolDiff(event.name, event.input);
      return `\n⏺ ${event.name}(${event.summary})\n${diff === undefined ? "" : `${diff}\n`}`;
    }
    case "tool_end":
      return event.isError ? `${styleText("red", `  ⎿ ${event.summary}`)}\n` : "";
    case "turn_result": {
      const lines: string[] = [];
      if (event.isError && event.errorMessage) {
        lines.push(styleText("red", event.errorMessage));
        if (/credit balance/i.test(event.errorMessage)) {
          lines.push(styleText("red", CREDIT_HINT));
        }
      }
      lines.push(styleText("dim", `── ${usd(event.costUsd)} · 누적 ${usd(event.totalCostUsd)}`));
      return `\n${lines.join("\n")}\n`;
    }
    case "error":
      return `\n${styleText("red", `오류: ${event.message}`)}\n`;
    case "session_closed": {
      const lines: string[] = [];
      if (event.sessionId) {
        lines.push(`세션 ID: ${event.sessionId}  (이어서: claud3 --resume ${event.sessionId})`);
      }
      lines.push(`누적 비용 ${usd(event.totalCostUsd)}`);
      return `\n${lines.join("\n")}\n`;
    }
  }
}

function isTty(stream: NodeJS.ReadableStream): boolean {
  return "isTTY" in stream && stream.isTTY === true;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorLine(message: string): string {
  return `${styleText("red", `오류: ${message}`)}\n`;
}

/** 기록 파일을 읽는다. 파일이 없거나 읽을 수 없으면 빈 기록으로 시작한다. */
function loadHistory(historyFile: string | undefined): string[] {
  if (historyFile === undefined) {
    return [];
  }
  try {
    return readFileSync(historyFile, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .slice(0, HISTORY_SIZE);
  } catch {
    return [];
  }
}

/** readline 기반 화면. 이벤트를 그리고, 입력과 권한 응답만 Session에 돌려준다. */
export function createPlainUi({ input, output, terminal = isTty(input), historyFile }: PlainUiIo): PlainUi {
  const rl = createInterface({
    input,
    output,
    terminal,
    prompt: PROMPT,
    historySize: HISTORY_SIZE,
    history: loadHistory(historyFile),
  });
  let activeQuestion: AbortController | undefined;
  let activeSession: Session | undefined;
  let lastIdleInterruptAt = 0;

  const write = (text: string): void => {
    if (text !== "") {
      output.write(text);
    }
  };

  if (historyFile !== undefined) {
    // 저장이 겹치지 않도록 차례로 쓰고, 실패는 처음 한 번만 알린다.
    let historyWrites: Promise<void> = Promise.resolve();
    let hasWarnedHistory = false;
    rl.on("history", (history: string[]) => {
      const content = `${history.slice(0, HISTORY_SIZE).join("\n")}\n`;
      historyWrites = historyWrites
        .then(async () => {
          await mkdir(dirname(historyFile), { recursive: true });
          await writeFile(historyFile, content, "utf8");
        })
        .catch((error: unknown) => {
          if (!hasWarnedHistory) {
            hasWarnedHistory = true;
            write(`\n${styleText("dim", `입력 기록을 저장하지 못했습니다: ${errorText(error)}`)}\n`);
          }
        });
    });
  }

  type AskResult = { kind: "answer"; text: string } | { kind: "cancelled"; by: "user" | "sdk" };

  // 사용자의 Ctrl+C(activeQuestion.abort)나 SDK의 취소 signal로 질문이 닫힐 수 있다.
  const ask = (question: string, sdkSignal: AbortSignal | undefined): Promise<AskResult> =>
    new Promise((resolve) => {
      const controller = new AbortController();
      activeQuestion = controller;
      const signal = sdkSignal ? AbortSignal.any([controller.signal, sdkSignal]) : controller.signal;
      signal.addEventListener(
        "abort",
        () => {
          activeQuestion = undefined;
          resolve({ kind: "cancelled", by: sdkSignal?.aborted ? "sdk" : "user" });
        },
        { once: true },
      );
      rl.question(question, { signal }, (answer) => {
        activeQuestion = undefined;
        resolve({ kind: "answer", text: answer });
      });
    });

  const askPermission: PermissionPrompter = async ({ toolName, summary, signal }) => {
    const question = `\n${toolName}(${summary}) 허용할까요? [y]이번만 [n]거부 [a]세션 동안 항상 › `;
    for (;;) {
      if (signal?.aborted) {
        return "deny";
      }
      const result = await ask(question, signal);
      if (result.kind === "cancelled") {
        if (result.by === "user") {
          void activeSession?.interrupt();
        }
        return "deny";
      }
      const decision = parseDecision(result.text);
      if (decision) {
        return decision;
      }
    }
  };

  // readline은 질문을 한 번에 하나만 받을 수 있으므로 동시에 온 권한 요청을 차례로 묻는다.
  let permissionQueue: Promise<unknown> = Promise.resolve();
  const prompter: PermissionPrompter = (request) => {
    const decision = permissionQueue.then(() => askPermission(request));
    permissionQueue = decision.catch(() => undefined);
    return decision;
  };

  const interruptTurn = (session: Session): void => {
    void session.interrupt();
    write(`\n${styleText("yellow", "(중단됨)")}\n`);
  };

  const run = (session: Session, { commandContext, recordUsage }: PlainRunOptions): Promise<void> =>
    new Promise((resolve) => {
      activeSession = session;
      const multiline = new MultilineBuffer();
      const markdown = createMarkdownRenderer();

      const promptIfIdle = (): void => {
        if (!session.isBusy) {
          rl.prompt();
        }
      };

      const printStatusLine = async (costUsd: number): Promise<void> => {
        try {
          const snapshot = await recordUsage(costUsd);
          const statusLine = formatStatusLine({
            model: session.currentModel,
            sessionCostUsd: session.totalCostUsd,
            remainingCreditUsd: remainingCreditUsd(snapshot),
          });
          write(`${statusLine}\n`);
        } catch (error) {
          write(errorLine(`사용량을 기록하지 못했습니다: ${errorText(error)}`));
        }
      };

      const renderEvent = async (event: UiEvent): Promise<void> => {
        if (event.type === "text_delta") {
          write(markdown.push(event.text));
          return;
        }
        write(markdown.flush());
        write(formatEvent(event));
        if (event.type === "turn_result") {
          await printStatusLine(event.costUsd);
        }
        if (event.type === "turn_result" || event.type === "error") {
          promptIfIdle();
        }
        if (event.type === "session_closed") {
          rl.close();
          resolve();
        }
      };

      // 사용량 기록을 기다리는 동안 다음 이벤트가 먼저 그려지지 않도록 차례로 처리한다.
      let rendering: Promise<void> = Promise.resolve();
      session.onEvent((event) => {
        rendering = rendering.then(() => renderEvent(event));
      });

      const submit = (text: string): void => {
        const parsed = parseInput(text);
        if (parsed.kind === "prompt") {
          session.send(text);
          promptIfIdle();
          return;
        }
        runCommand(parsed, commandContext)
          .catch((error: unknown) => write(errorLine(errorText(error))))
          .finally(promptIfIdle);
      };

      rl.on("line", (line) => {
        const text = multiline.push(line);
        if (text === undefined) {
          rl.setPrompt(CONTINUATION_PROMPT);
          rl.prompt();
          return;
        }
        rl.setPrompt(PROMPT);
        submit(text);
      });

      rl.on("SIGINT", () => {
        if (activeQuestion) {
          activeQuestion.abort();
          return;
        }
        if (multiline.isCollecting) {
          multiline.reset();
          rl.setPrompt(PROMPT);
          write("\n");
          rl.prompt();
          return;
        }
        if (session.isBusy) {
          interruptTurn(session);
          return;
        }
        const now = Date.now();
        if (now - lastIdleInterruptAt <= EXIT_CONFIRM_WINDOW_MS) {
          void session.close();
          return;
        }
        lastIdleInterruptAt = now;
        write(`\n${styleText("dim", "한 번 더 누르면 종료합니다")}\n`);
        rl.prompt();
      });

      rl.on("close", () => {
        void session.close();
      });

      if (terminal) {
        emitKeypressEvents(input);
        input.on("keypress", (_text: string | undefined, key: { name?: string } | undefined) => {
          if (key?.name === "escape" && !activeQuestion && session.isBusy) {
            interruptTurn(session);
          }
        });
      }

      session.start();
      rl.prompt();
    });

  return { prompter, run };
}
