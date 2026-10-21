import { createInterface, emitKeypressEvents } from "node:readline";
import { styleText } from "node:util";
import type { Session } from "../session.js";
import type { PermissionDecision, PermissionPrompter, UiEvent } from "../types.js";

const PROMPT = "> ";
const EXIT_CONFIRM_WINDOW_MS = 2000;
const CREDIT_HINT = "프로모션 크레딧이 소진되었거나 만료되었을 수 있습니다 (Console › Billing 확인)";

export interface PlainUiIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export interface PlainUi {
  prompter: PermissionPrompter;
  run(session: Session): Promise<void>;
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
    case "tool_start":
      return `\n⏺ ${event.name}(${event.summary})\n`;
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

/** readline 기반 화면. 이벤트를 그리고, 입력과 권한 응답만 Session에 돌려준다. */
export function createPlainUi({ input, output }: PlainUiIo): PlainUi {
  const terminal = isTty(input);
  const rl = createInterface({ input, output, terminal, prompt: PROMPT });
  let activeQuestion: AbortController | undefined;
  let activeSession: Session | undefined;
  let lastIdleInterruptAt = 0;

  const write = (text: string): void => {
    if (text !== "") {
      output.write(text);
    }
  };

  // 질문이 Ctrl+C로 취소되면 undefined를 돌려준다.
  const ask = (question: string): Promise<string | undefined> =>
    new Promise((resolve) => {
      const controller = new AbortController();
      activeQuestion = controller;
      controller.signal.addEventListener(
        "abort",
        () => {
          activeQuestion = undefined;
          resolve(undefined);
        },
        { once: true },
      );
      rl.question(question, { signal: controller.signal }, (answer) => {
        activeQuestion = undefined;
        resolve(answer);
      });
    });

  const prompter: PermissionPrompter = async ({ toolName, summary }) => {
    const question = `\n${toolName}(${summary}) 허용할까요? [y]이번만 [n]거부 [a]세션 동안 항상 › `;
    for (;;) {
      const answer = await ask(question);
      if (answer === undefined) {
        void activeSession?.interrupt();
        return "deny";
      }
      const decision = parseDecision(answer);
      if (decision) {
        return decision;
      }
    }
  };

  const interruptTurn = (session: Session): void => {
    void session.interrupt();
    write(`\n${styleText("yellow", "(중단됨)")}\n`);
  };

  const run = (session: Session): Promise<void> =>
    new Promise((resolve) => {
      activeSession = session;

      session.onEvent((event) => {
        write(formatEvent(event));
        if (event.type === "turn_result" || event.type === "error") {
          if (!session.isBusy) {
            rl.prompt();
          }
        }
        if (event.type === "session_closed") {
          rl.close();
          resolve();
        }
      });

      rl.on("line", (line) => {
        session.send(line);
        if (!session.isBusy) {
          rl.prompt();
        }
      });

      rl.on("SIGINT", () => {
        if (activeQuestion) {
          activeQuestion.abort();
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
