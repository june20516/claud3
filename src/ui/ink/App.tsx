import { Box, useBoxMetrics, useInput } from "ink";
import type { DOMElement } from "ink";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { CommandContext } from "../../commands.js";
import { parseInput, runCommand } from "../../commands.js";
import { nextPermissionMode } from "../../permissionModes.js";
import type { Session } from "../../session.js";
import type {
  PermissionDecision,
  PermissionPrompter,
  PermissionRequest,
  UiEvent,
  UserQuestion,
  UserQuestionAnswers,
  UserQuestionPrompter,
  UserQuestionRequest,
} from "../../types.js";
import { remainingCreditUsd } from "../../usageStore.js";
import { formatAnswerSummary } from "../../userQuestions.js";
import type { SessionListItem } from "../../sessionList.js";
import { formatPlanPreview } from "../plain.js";
import type { UiRunOptions } from "../runOptions.js";
import { InputBox } from "./InputBox.js";
import { PermissionDialog } from "./PermissionDialog.js";
import { QuestionDialog } from "./QuestionDialog.js";
import { SessionPicker } from "./SessionPicker.js";
import { StatusBar } from "./StatusBar.js";
import { Transcript } from "./TranscriptView.js";
import type { NoticeTone, TranscriptState } from "./transcript.js";
import { addNotice, addUserInput, commitStreaming, initialTranscript, reduceTranscript } from "./transcript.js";

const EXIT_CONFIRM_WINDOW_MS = 2000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface InkUiSnapshot {
  transcript: TranscriptState;
  /** 지금 떠 있는 권한·계획 질문. 나머지 요청은 차례를 기다린다. id는 질문마다 새 대화상자를 그리는 key다. */
  dialog?: { id: number; request: PermissionRequest };
  /** 지금 묻는 AskUserQuestion 질문. 권한 질문과 같은 대기열로 하나씩 뜬다. */
  question?: QuestionDialogState;
  /** /resume 세션 목록 창. id는 열 때마다 새로 매기는 key다. */
  picker?: { id: number; items: SessionListItem[] };
  /** 시작 잔액을 읽기 전에는 없다. */
  remainingCreditUsd?: number;
}

export interface QuestionDialogState {
  /** 질문 요청마다 새로 매긴다. index와 함께 질문 창의 key가 된다. */
  id: number;
  questions: UserQuestion[];
  /** 지금 묻는 질문의 위치. */
  index: number;
  /** 직접 입력 중이면 입력창이 답을 받는다. */
  typing: boolean;
}

/**
 * Ink 화면의 상태. prompter는 화면이 그려지기 전부터 Session에 넘겨지므로 React 밖에 둔다.
 * 컴포넌트는 useSyncExternalStore로 구독한다.
 */
export class InkUiStore {
  private snapshot: InkUiSnapshot = { transcript: initialTranscript };
  private readonly listeners = new Set<() => void>();
  private answerDialog: ((decision: PermissionDecision) => void) | undefined;
  /** 떠 있는 질문 창을 닫는다. 취소면 undefined를 넘긴다. */
  private closeQuestion: ((answers: UserQuestionAnswers | undefined) => void) | undefined;
  private questionAnswers: UserQuestionAnswers = {};
  private closePicker: ((sessionId: string | undefined) => void) | undefined;
  /** 권한 질문과 AskUserQuestion은 화면 하나를 같이 쓰므로 한 대기열로 차례를 정한다. */
  private dialogQueue: Promise<unknown> = Promise.resolve();
  private nextDialogId = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): InkUiSnapshot => this.snapshot;

  /** 동시에 온 요청은 대기열에 넣고 하나씩 대화상자로 묻는다. */
  readonly prompter: PermissionPrompter = (request) => this.enqueue(() => this.askPermission(request));

  readonly asker: UserQuestionPrompter = (request) => this.enqueue(() => this.askQuestions(request));

  /** 세션 목록 창을 띄우고 고른 세션 ID를 돌려준다. 취소하면 undefined. */
  readonly pickSession = (items: SessionListItem[]): Promise<string | undefined> =>
    this.enqueue(
      () =>
        new Promise<string | undefined>((resolve) => {
          this.closePicker = (sessionId) => {
            this.closePicker = undefined;
            this.update({ picker: undefined });
            resolve(sessionId);
          };
          this.update({ picker: { id: this.nextDialogId++, items } });
        }),
    );

  answerPicker(sessionId: string | undefined): void {
    this.closePicker?.(sessionId);
  }

  /** 떠 있는 대화상자에 답한다. 없으면 무시한다. */
  answer(decision: PermissionDecision): void {
    this.answerDialog?.(decision);
  }

  /** 지금 질문의 답을 기록하고 다음 질문으로 넘어간다. 마지막 질문이면 답을 돌려준다. */
  answerQuestion(answer: string): void {
    const { question } = this.snapshot;
    const current = question?.questions[question.index];
    if (question === undefined || current === undefined) {
      return;
    }
    this.questionAnswers = { ...this.questionAnswers, [current.question]: answer };
    const nextIndex = question.index + 1;
    if (nextIndex < question.questions.length) {
      this.update({ question: { ...question, index: nextIndex, typing: false } });
      return;
    }
    this.closeQuestion?.(this.questionAnswers);
  }

  cancelQuestion(): void {
    this.closeQuestion?.(undefined);
  }

  setQuestionTyping(typing: boolean): void {
    const { question } = this.snapshot;
    if (question !== undefined) {
      this.update({ question: { ...question, typing } });
    }
  }

  applyEvent(event: UiEvent): void {
    let transcript = reduceTranscript(this.snapshot.transcript, event);
    // plain 화면처럼 연결될 때마다 머리줄을 대화 흐름에 남긴다.
    if (event.type === "session_start" && transcript.header !== undefined) {
      transcript = addNotice(transcript, "dim", transcript.header);
    }
    this.update({ transcript });
  }

  addUserInput(text: string): void {
    this.update({ transcript: addUserInput(this.snapshot.transcript, text) });
  }

  addNotice(tone: NoticeTone, text: string): void {
    this.update({ transcript: addNotice(this.snapshot.transcript, tone, text) });
  }

  setRemainingCredit(amountUsd: number): void {
    this.update({ remainingCreditUsd: amountUsd });
  }

  private askPermission(request: PermissionRequest): Promise<PermissionDecision> {
    const { signal, plan } = request;
    if (signal?.aborted) {
      return Promise.resolve("deny");
    }
    return new Promise((resolve) => {
      const close = (decision: PermissionDecision): void => {
        signal?.removeEventListener("abort", onAbort);
        this.answerDialog = undefined;
        this.update({ dialog: undefined });
        resolve(decision);
      };
      const onAbort = (): void => close("deny");
      signal?.addEventListener("abort", onAbort, { once: true });
      this.answerDialog = close;

      // 질문이 진행 중 응답 아래에 끼지 않도록 먼저 확정하고, 긴 계획 본문은 대화 영역에 남긴다.
      let transcript = commitStreaming(this.snapshot.transcript);
      if (plan !== undefined) {
        transcript = addNotice(transcript, "info", formatPlanPreview(request, plan).replace(/^\n+|\n+$/g, ""));
      }
      this.update({ transcript, dialog: { id: this.nextDialogId++, request } });
    });
  }

  private enqueue<T>(askNext: () => Promise<T>): Promise<T> {
    const result = this.dialogQueue.then(askNext);
    this.dialogQueue = result.catch(() => undefined);
    return result;
  }

  private askQuestions({ questions, signal }: UserQuestionRequest): Promise<UserQuestionAnswers | undefined> {
    if (signal?.aborted) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      const close = (answers: UserQuestionAnswers | undefined): void => {
        signal?.removeEventListener("abort", onAbort);
        this.closeQuestion = undefined;
        this.questionAnswers = {};
        // 답은 대화 영역에 남겨 나중에 무엇을 골랐는지 볼 수 있게 한다.
        const transcript =
          answers === undefined
            ? this.snapshot.transcript
            : addNotice(this.snapshot.transcript, "info", formatAnswerSummary(questions, answers));
        this.update({ transcript, question: undefined });
        resolve(answers);
      };
      const onAbort = (): void => close(undefined);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.closeQuestion = close;
      this.questionAnswers = {};
      this.update({
        transcript: commitStreaming(this.snapshot.transcript),
        question: { id: this.nextDialogId++, questions, index: 0, typing: false },
      });
    });
  }

  private update(changes: Partial<InkUiSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/**
 * Session 이벤트를 store에 반영하고 시작 잔액을 읽는다.
 * turn_result는 사용량 기록이 끝난 뒤 다음 이벤트를 처리하고, session_closed 뒤에는 onClosed를 부른다.
 */
export function connectSession(
  store: InkUiStore,
  session: Session,
  { commandContext, recordUsage }: UiRunOptions,
  onClosed: () => void,
): void {
  const handleEvent = async (event: UiEvent): Promise<void> => {
    store.applyEvent(event);
    if (event.type === "turn_result") {
      try {
        store.setRemainingCredit(remainingCreditUsd(await recordUsage(event.costUsd)));
      } catch (error) {
        store.addNotice("error", `오류: 사용량을 기록하지 못했습니다: ${errorText(error)}`);
      }
    }
    if (event.type === "session_closed") {
      onClosed();
    }
  };

  let processing: Promise<void> = Promise.resolve();
  session.onEvent((event) => {
    processing = processing
      .then(() => handleEvent(event))
      .catch((error: unknown) => store.addNotice("error", `오류: ${errorText(error)}`));
  });

  commandContext.readUsage().then(
    (snapshot) => {
      // 그새 턴이 끝나 더 새 값이 들어왔으면 덮어쓰지 않는다.
      if (store.getSnapshot().remainingCreditUsd === undefined) {
        store.setRemainingCredit(remainingCreditUsd(snapshot));
      }
    },
    (error: unknown) => store.addNotice("error", `오류: 사용량을 읽지 못했습니다: ${errorText(error)}`),
  );
}

export interface AppProps {
  store: InkUiStore;
  session: Session;
  commandContext: UiRunOptions["commandContext"];
  initialHistory: readonly string[];
  saveHistory?: (history: string[]) => void;
  /** 처음 그린 뒤 한 번 실행할 명령. */
  startupCommand?: string;
}

/** 대화, 대화상자, 입력창, 상태 줄을 배치하고 화면 전체 키(Esc·Ctrl+C·Shift+Tab)를 처리한다. Ctrl+D는 InputBox가 받는다. */
export function App({ store, session, commandContext, initialHistory, saveHistory, startupCommand }: AppProps) {
  const {
    transcript,
    dialog,
    question,
    picker,
    remainingCreditUsd: remaining,
  } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const lastIdleInterruptAt = useRef(0);
  // Static은 레이아웃 밖(absolute)이므로 입력창의 top이 곧 동적 출력 맨 위에서 센 행이다.
  const inputBoxRef = useRef<DOMElement>(null);
  const inputBoxMetrics = useBoxMetrics(inputBoxRef);

  const interruptTurn = (): void => {
    void session.interrupt();
    store.addNotice("dim", "(중단됨)");
  };

  const cancelQuestionAndInterrupt = (): void => {
    store.cancelQuestion();
    void session.interrupt();
  };

  // InputBox가 받은 Ctrl+C. 여러 줄 입력 취소는 InputBox가 이미 처리했다.
  const handleInterrupt = (): void => {
    // 질문의 직접 입력 중이면 대화상자의 Ctrl+C처럼 질문을 취소하고 턴을 중단한다.
    if (store.getSnapshot().question !== undefined) {
      cancelQuestionAndInterrupt();
      return;
    }
    if (session.isBusy) {
      interruptTurn();
      return;
    }
    const now = Date.now();
    if (now - lastIdleInterruptAt.current <= EXIT_CONFIRM_WINDOW_MS) {
      void session.close();
      return;
    }
    lastIdleInterruptAt.current = now;
    store.addNotice("dim", "한 번 더 누르면 종료합니다");
  };

  const print: CommandContext["print"] = (text) => store.addNotice("info", text);

  const runInput = (text: string): void => {
    const parsed = parseInput(text);
    if (parsed.kind === "prompt") {
      session.send(text);
      return;
    }
    runCommand(parsed, { ...commandContext, print, pickSession: store.pickSession }).catch((error: unknown) =>
      store.addNotice("error", `오류: ${errorText(error)}`),
    );
  };

  const submit = (text: string): void => {
    if (text.trim() === "") {
      return;
    }
    if (store.getSnapshot().question?.typing === true) {
      store.answerQuestion(text.trim());
      return;
    }
    store.addUserInput(text);
    runInput(text);
  };

  // 시작 명령은 처음 그린 뒤 한 번만 실행한다(입력한 것이 아니므로 대화 영역에 남기지 않는다).
  const startedRef = useRef(false);
  useEffect(() => {
    if (startupCommand !== undefined && !startedRef.current) {
      startedRef.current = true;
      runInput(startupCommand);
    }
  });

  // 대화상자가 떠 있는 동안 Esc·단축키는 PermissionDialog가 받는다.
  // 한 청크의 여러 키는 렌더 없이 연달아 오므로 대화상자 여부는 store에서 바로 읽는다.
  useInput((input, key) => {
    const snapshot = store.getSnapshot();
    if (snapshot.dialog !== undefined) {
      if (key.ctrl && input === "c") {
        store.answer("deny");
        void session.interrupt();
      }
      return;
    }
    // 목록 창의 키는 SessionPicker가 받는다. Ctrl+C는 취소로 본다.
    if (snapshot.picker !== undefined) {
      if (key.ctrl && input === "c") {
        store.answerPicker(undefined);
      }
      return;
    }
    // 질문 창의 키는 QuestionDialog가 받는다. 직접 입력 중의 Ctrl+C는 InputBox가 받아 handleInterrupt로 온다.
    if (snapshot.question !== undefined) {
      if (key.ctrl && input === "c" && !snapshot.question.typing) {
        cancelQuestionAndInterrupt();
      }
      return;
    }
    if (key.escape && session.isBusy) {
      interruptTurn();
    } else if (key.tab && key.shift) {
      session
        .setPermissionMode(nextPermissionMode(session.currentPermissionMode))
        .catch((error: unknown) => store.addNotice("error", `오류: ${errorText(error)}`));
    }
  });

  return (
    <Box flexDirection="column">
      <Transcript state={transcript} />
      {dialog === undefined ? null : (
        <Box marginTop={1}>
          <PermissionDialog
            key={dialog.id}
            request={dialog.request}
            onDecision={(decision) => store.answer(decision)}
          />
        </Box>
      )}
      {question === undefined ? null : (
        <Box marginTop={1}>
          <QuestionDialog
            key={`${question.id}-${question.index}`}
            question={question.questions[question.index] ?? question.questions[0]!}
            index={question.index}
            total={question.questions.length}
            typing={question.typing}
            onAnswer={(answer) => store.answerQuestion(answer)}
            onStartTyping={() => store.setQuestionTyping(true)}
            onStopTyping={() => store.setQuestionTyping(false)}
            onCancel={() => store.cancelQuestion()}
          />
        </Box>
      )}
      {picker === undefined ? null : (
        <Box marginTop={1}>
          <SessionPicker
            key={picker.id}
            items={picker.items}
            onPick={(sessionId) => store.answerPicker(sessionId)}
            onCancel={() => store.answerPicker(undefined)}
          />
        </Box>
      )}
      <Box ref={inputBoxRef} marginTop={1}>
        <InputBox
          originRow={inputBoxMetrics.hasMeasured ? inputBoxMetrics.top : undefined}
          isActive={dialog === undefined && picker === undefined && (question === undefined || question.typing)}
          initialHistory={initialHistory}
          onSubmit={submit}
          onInterrupt={handleInterrupt}
          onHistoryChange={saveHistory}
          onExit={() => void session.close()}
        />
      </Box>
      <StatusBar
        model={session.currentModel ?? transcript.model}
        permissionMode={session.currentPermissionMode ?? transcript.permissionMode}
        sessionCostUsd={session.totalCostUsd}
        remainingCreditUsd={remaining}
      />
    </Box>
  );
}
