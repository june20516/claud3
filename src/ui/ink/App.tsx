import { Box, useBoxMetrics, useInput } from "ink";
import type { DOMElement } from "ink";
import { useRef, useSyncExternalStore } from "react";
import type { CommandContext } from "../../commands.js";
import { parseInput, runCommand } from "../../commands.js";
import { nextPermissionMode } from "../../permissionModes.js";
import type { Session } from "../../session.js";
import type { PermissionDecision, PermissionPrompter, PermissionRequest, UiEvent } from "../../types.js";
import { remainingCreditUsd } from "../../usageStore.js";
import { formatPlanPreview } from "../plain.js";
import type { UiRunOptions } from "../runOptions.js";
import { InputBox } from "./InputBox.js";
import { PermissionDialog } from "./PermissionDialog.js";
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
  /** 시작 잔액을 읽기 전에는 없다. */
  remainingCreditUsd?: number;
}

/**
 * Ink 화면의 상태. prompter는 화면이 그려지기 전부터 Session에 넘겨지므로 React 밖에 둔다.
 * 컴포넌트는 useSyncExternalStore로 구독한다.
 */
export class InkUiStore {
  private snapshot: InkUiSnapshot = { transcript: initialTranscript };
  private readonly listeners = new Set<() => void>();
  private answerDialog: ((decision: PermissionDecision) => void) | undefined;
  private permissionQueue: Promise<unknown> = Promise.resolve();
  private nextDialogId = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): InkUiSnapshot => this.snapshot;

  /** 동시에 온 요청은 대기열에 넣고 하나씩 대화상자로 묻는다. */
  readonly prompter: PermissionPrompter = (request) => {
    const decision = this.permissionQueue.then(() => this.askPermission(request));
    this.permissionQueue = decision.catch(() => undefined);
    return decision;
  };

  /** 떠 있는 대화상자에 답한다. 없으면 무시한다. */
  answer(decision: PermissionDecision): void {
    this.answerDialog?.(decision);
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
}

/** 대화, 대화상자, 입력창, 상태 줄을 배치하고 화면 전체 키(Esc·Ctrl+C·Shift+Tab)를 처리한다. Ctrl+D는 InputBox가 받는다. */
export function App({ store, session, commandContext, initialHistory, saveHistory }: AppProps) {
  const { transcript, dialog, remainingCreditUsd: remaining } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const lastIdleInterruptAt = useRef(0);
  // Static은 레이아웃 밖(absolute)이므로 입력창의 top이 곧 동적 출력 맨 위에서 센 행이다.
  const inputBoxRef = useRef<DOMElement>(null);
  const inputBoxMetrics = useBoxMetrics(inputBoxRef);

  const interruptTurn = (): void => {
    void session.interrupt();
    store.addNotice("dim", "(중단됨)");
  };

  // InputBox가 받은 Ctrl+C. 여러 줄 입력 취소는 InputBox가 이미 처리했다.
  const handleInterrupt = (): void => {
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

  const submit = (text: string): void => {
    if (text.trim() === "") {
      return;
    }
    store.addUserInput(text);
    const parsed = parseInput(text);
    if (parsed.kind === "prompt") {
      session.send(text);
      return;
    }
    runCommand(parsed, { ...commandContext, print }).catch((error: unknown) =>
      store.addNotice("error", `오류: ${errorText(error)}`),
    );
  };

  // 대화상자가 떠 있는 동안 Esc·단축키는 PermissionDialog가 받는다.
  // 한 청크의 여러 키는 렌더 없이 연달아 오므로 대화상자 여부는 store에서 바로 읽는다.
  useInput((input, key) => {
    if (store.getSnapshot().dialog !== undefined) {
      if (key.ctrl && input === "c") {
        store.answer("deny");
        void session.interrupt();
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
      <Box ref={inputBoxRef} marginTop={1}>
        <InputBox
          originRow={inputBoxMetrics.hasMeasured ? inputBoxMetrics.top : undefined}
          isActive={dialog === undefined}
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
