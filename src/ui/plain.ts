import { createInterface, emitKeypressEvents } from "node:readline";
import { styleText } from "node:util";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { parseInput, runCommand } from "../commands.js";
import { formatToolDiff } from "../diffView.js";
import { HISTORY_SIZE, createHistorySaver, loadHistory } from "../inputHistory.js";
import { createMarkdownRenderer } from "../markdown.js";
import { describePermissionMode, nextPermissionMode } from "../permissionModes.js";
import type { Session } from "../session.js";
import type {
  PermissionDecision,
  PermissionPrompter,
  PermissionRequest,
  UiEvent,
  UserQuestionAnswers,
  UserQuestionPrompter,
  UserQuestionRequest,
} from "../types.js";
import { remainingCreditUsd } from "../usageStore.js";
import { formatQuestionPrompt, parseQuestionAnswer } from "../userQuestions.js";
import { formatSessionTime } from "../sessionList.js";
import type { SessionListItem } from "../sessionList.js";
import { formatLocation } from "../workspaceInfo.js";
import type { ChatUi, UiRunOptions } from "./runOptions.js";

const PROMPT = "> ";
const CONTINUATION_PROMPT = "… ";
const EXIT_CONFIRM_WINDOW_MS = 2000;
const ANSWER_PROMPT = "답 › ";
const PICK_PROMPT = "번호 › ";
const PLAN_QUESTION = "\n계획을 승인할까요? [y]승인 [e]승인+편집 자동 허용 [n]계속 계획 › ";
export const HISTORY_HEADER = "── 이전 대화 ──";
export const CREDIT_HINT = "프로모션 크레딧이 소진되었거나 만료되었을 수 있습니다 (Console › Billing 확인)";

export interface PlainUiIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** 기본값은 input이 TTY인지 여부. */
  terminal?: boolean;
  /** 입력 기록 파일. 첫 줄이 가장 최근 입력이다. */
  historyFile?: string;
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

export interface StatusLineParams {
  model?: string;
  permissionMode?: PermissionMode;
  sessionCostUsd: number;
  /** 시작 잔액을 아직 모르면 없다. 잔액 부분만 빼고 그린다. */
  remainingCreditUsd?: number;
}

/** 스타일 없는 상태 줄 문구. 화면마다 다른 스타일을 입힌다. */
export function statusLineText(params: StatusLineParams): string {
  const parts = [
    params.model ?? "기본 모델",
    ...(params.permissionMode === undefined ? [] : [params.permissionMode]),
    `세션 ${usd(params.sessionCostUsd)}`,
    ...(params.remainingCreditUsd === undefined ? [] : [`크레딧 잔여 추정 $${params.remainingCreditUsd.toFixed(2)}`]),
  ];
  return parts.join(" · ");
}

export function formatStatusLine(params: StatusLineParams): string {
  return styleText("dim", statusLineText(params));
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

export function parsePlanDecision(answer: string): PermissionDecision | undefined {
  switch (answer.trim().toLowerCase()) {
    case "y":
    case "yes":
      return "allow";
    case "e":
      return "allowAcceptEdits";
    case "n":
    case "no":
      return "deny";
    default:
      return undefined;
  }
}

/** 계획 질문 앞에 보일 내용. 본문, 계획 파일 경로, 도구 요약 순으로 있는 것 하나만 보인다. */
export function formatPlanPreview(request: PermissionRequest, plan: { text?: string; filePath?: string }): string {
  if (plan.text !== undefined && plan.text.trim() !== "") {
    const renderer = createMarkdownRenderer();
    return `\n${renderer.push(`${plan.text}\n`)}${renderer.flush()}`;
  }
  if (plan.filePath !== undefined && plan.filePath !== "") {
    return `\n계획 파일: ${plan.filePath}\n`;
  }
  return `\n${request.toolName}(${request.summary})\n`;
}

export function formatEvent(event: UiEvent): string {
  switch (event.type) {
    case "session_start":
      return `${styleText("dim", `claud3 · API key(${event.apiKeySource}) · Agent SDK · ${event.model}`)}\n`;
    case "history":
      return `\n${styleText("dim", HISTORY_HEADER)}\n${event.lines.join("\n")}\n`;
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
    case "permission_mode":
      return `\n${styleText("dim", `권한 모드: ${describePermissionMode(event.mode)}`)}\n`;
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

/** readline 기반 화면. 이벤트를 그리고, 입력과 권한 응답만 Session에 돌려준다. */
export function createPlainUi({ input, output, terminal = isTty(input), historyFile }: PlainUiIo): ChatUi {
  const initialHistory = loadHistory(historyFile);
  const rl = createInterface({
    input,
    output,
    terminal,
    prompt: PROMPT,
    historySize: HISTORY_SIZE,
    history: [...initialHistory],
  });
  let activeQuestion: AbortController | undefined;
  let activeSession: Session | undefined;
  let lastIdleInterruptAt = 0;

  const write = (text: string): void => {
    if (text !== "") {
      output.write(text);
    }
  };

  const saveHistory =
    historyFile === undefined
      ? undefined
      : createHistorySaver(historyFile, (error) =>
          write(`\n${styleText("dim", `입력 기록을 저장하지 못했습니다: ${errorText(error)}`)}\n`),
        );

  // readline은 권한 질문의 답도 기록에 넣고, 답을 넘기기 전에 history 이벤트를 낸다.
  // 이벤트의 배열은 readline 내부 기록 자체이므로, 질문 중이면 직전 기록으로 되돌리고 저장하지 않는다.
  let acceptedHistory = initialHistory;
  rl.on("history", (history: string[]) => {
    if (activeQuestion) {
      history.splice(0, history.length, ...acceptedHistory);
      return;
    }
    acceptedHistory = [...history];
    saveHistory?.(history);
  });

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

  const askPermission: PermissionPrompter = async (request) => {
    const { toolName, summary, signal, plan } = request;
    const question =
      plan === undefined
        ? `\n${toolName}(${summary}) 허용할까요? [y]이번만 [n]거부 [a]세션 동안 항상 › `
        : PLAN_QUESTION;
    const parse = plan === undefined ? parseDecision : parsePlanDecision;
    if (plan !== undefined && !signal?.aborted) {
      write(formatPlanPreview(request, plan));
    }
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
      const decision = parse(result.text);
      if (decision) {
        return decision;
      }
    }
  };

  /** 질문을 하나씩 보이고 답을 모은다. 취소되면 undefined. */
  const askQuestions = async ({ questions, signal }: UserQuestionRequest): Promise<UserQuestionAnswers | undefined> => {
    const answers: UserQuestionAnswers = {};
    for (const [index, question] of questions.entries()) {
      if (signal?.aborted) {
        return undefined;
      }
      write(`\n${formatQuestionPrompt(question, index, questions.length)}\n`);
      for (;;) {
        const result = await ask(ANSWER_PROMPT, signal);
        if (result.kind === "cancelled") {
          if (result.by === "user") {
            void activeSession?.interrupt();
          }
          return undefined;
        }
        const answer = parseQuestionAnswer(result.text, question);
        if (answer !== undefined) {
          answers[question.question] = answer;
          break;
        }
      }
    }
    return answers;
  };

  /** 세션 목록을 번호와 함께 보이고 번호로 고르게 한다. 빈 답이나 Ctrl+C는 취소. */
  const askSession = async (items: SessionListItem[]): Promise<string | undefined> => {
    const now = Date.now();
    const lines = items.map((item, index) => `  ${index + 1}. ${item.title} · ${formatSessionTime(item.lastModified, now)}`);
    write(`\n이어서 열 세션 (최신순, 빈 줄은 취소)\n${lines.join("\n")}\n`);
    for (;;) {
      const result = await ask(PICK_PROMPT, undefined);
      if (result.kind === "cancelled" || result.text.trim() === "") {
        return undefined;
      }
      const picked = /^\d+$/.test(result.text.trim()) ? items[Number(result.text.trim()) - 1] : undefined;
      if (picked !== undefined) {
        return picked.sessionId;
      }
    }
  };

  // readline은 질문을 한 번에 하나만 받을 수 있으므로 동시에 온 권한 요청과 질문을 차례로 묻는다.
  let questionQueue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(askNext: () => Promise<T>): Promise<T> => {
    const result = questionQueue.then(askNext);
    questionQueue = result.catch(() => undefined);
    return result;
  };
  const prompter: PermissionPrompter = (request) => enqueue(() => askPermission(request));
  const asker: UserQuestionPrompter = (request) => enqueue(() => askQuestions(request));
  const pickSession = (items: SessionListItem[]): Promise<string | undefined> => enqueue(() => askSession(items));

  const interruptTurn = (session: Session): void => {
    void session.interrupt();
    write(`\n${styleText("yellow", "(중단됨)")}\n`);
  };

  const run = (
    session: Session,
    { commandContext, recordUsage, startupCommand, readWorkspace }: UiRunOptions,
  ): Promise<void> =>
    new Promise((resolve) => {
      activeSession = session;
      const multiline = new MultilineBuffer();
      const markdown = createMarkdownRenderer();

      const promptIfIdle = (): void => {
        if (!session.isBusy) {
          rl.prompt();
        }
      };

      // 입력 중이던 줄을 보존한 채 프롬프트를 다시 그린다.
      const redrawPromptIfIdle = (): void => {
        if (!session.isBusy) {
          rl.prompt(true);
        }
      };

      const printStatusLine = async (costUsd: number): Promise<void> => {
        try {
          const snapshot = await recordUsage(costUsd);
          const statusLine = formatStatusLine({
            model: session.currentModel,
            permissionMode: session.currentPermissionMode,
            sessionCostUsd: session.totalCostUsd,
            remainingCreditUsd: remainingCreditUsd(snapshot),
          });
          // 위치는 보조 정보라 읽지 못하면 빼고 보인다.
          const workspace = await readWorkspace?.().catch(() => undefined);
          const location = workspace === undefined ? "" : `${styleText("cyan", formatLocation(workspace))}${styleText("dim", " · ")}`;
          write(`${location}${statusLine}\n`);
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
        if (event.type === "permission_mode") {
          redrawPromptIfIdle();
        }
        if (event.type === "session_closed") {
          rl.close();
          resolve();
        }
      };

      // 사용량 기록을 기다리는 동안 다음 이벤트가 먼저 그려지지 않도록 차례로 처리한다.
      let rendering: Promise<void> = Promise.resolve();
      session.onEvent((event) => {
        rendering = rendering
          .then(() => renderEvent(event))
          .catch((error: unknown) => write(errorLine(errorText(error))));
      });

      const print = (text: string): void => {
        output.write(`${text}\n`);
      };

      const submit = (text: string): void => {
        const parsed = parseInput(text);
        if (parsed.kind === "prompt") {
          session.send(text);
          promptIfIdle();
          return;
        }
        runCommand(parsed, { ...commandContext, print, pickSession })
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
        input.on("keypress", (_text: string | undefined, key: { name?: string; shift?: boolean } | undefined) => {
          if (key?.name === "escape" && !activeQuestion && session.isBusy) {
            interruptTurn(session);
          }
          if (key?.name === "tab" && key.shift === true && !activeQuestion) {
            session
              .setPermissionMode(nextPermissionMode(session.currentPermissionMode))
              .catch((error: unknown) => {
                write(formatEvent({ type: "error", message: errorText(error) }));
                redrawPromptIfIdle();
              });
          }
        });
      }

      session.start();
      if (startupCommand === undefined) {
        rl.prompt();
      } else {
        // 명령이 끝나면 submit이 프롬프트를 띄운다.
        submit(startupCommand);
      }
    });

  return { prompter, asker, run };
}
