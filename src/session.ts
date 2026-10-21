import type { CanUseTool, Options, PermissionResult, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "./asyncQueue.js";
import { createEventMapper, summarizeToolInput } from "./events.js";
import type { PermissionPrompter, UiEvent } from "./types.js";

/** Session이 쓰는 query 기능만 추린 타입. SDK의 Query도 이 타입을 만족한다. */
export type SessionQuery = AsyncIterable<SDKMessage> & { interrupt(): Promise<unknown> };

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => SessionQuery;

export interface SessionDeps {
  queryFn: QueryFn;
  baseOptions: Options;
  prompter: PermissionPrompter;
  resume?: string;
}

const DENIED_MESSAGE = "사용자가 거부했습니다";
const PENDING_CANCELLED_MESSAGE = "재연결로 대기 중 입력이 취소되었습니다";

function toUserMessage(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 하나의 query()를 streaming input mode로 유지한다.
 * 입력은 한 번에 한 턴씩 SDK로 보내고, 턴 실행 중 입력은 직접 보관했다가 턴이 끝나면 보낸다.
 */
export class Session {
  private readonly listeners: ((event: UiEvent) => void)[] = [];
  private readonly alwaysAllowedTools = new Set<string>();
  private readonly pendingInputs: string[] = [];
  private input = new AsyncQueue<SDKUserMessage>();
  private query: SessionQuery | undefined;
  private busy = false;
  private closed = false;
  private currentSessionId: string | undefined;
  private accumulatedCostUsd = 0;

  constructor(private readonly deps: SessionDeps) {
    this.currentSessionId = deps.resume;
  }

  get sessionId(): string | undefined {
    return this.currentSessionId;
  }

  get totalCostUsd(): number {
    return this.accumulatedCostUsd;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  onEvent(listener: (event: UiEvent) => void): void {
    this.listeners.push(listener);
  }

  start(): void {
    this.connect(this.deps.resume, false);
  }

  send(text: string): void {
    if (this.closed || text.trim() === "") {
      return;
    }
    if (this.busy) {
      this.pendingInputs.push(text);
      return;
    }
    this.deliver(text);
  }

  async interrupt(): Promise<void> {
    if (!this.busy || !this.query) {
      return;
    }
    this.pendingInputs.length = 0;
    try {
      await this.query.interrupt();
    } catch (error) {
      // 연결이 막 끊긴 순간에는 interrupt가 실패할 수 있다. 프로세스를 죽이지 않고 알리기만 한다.
      this.emit({ type: "error", message: `중단 요청 실패: ${errorText(error)}` });
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.input.close();
    this.emit({ type: "session_closed", sessionId: this.currentSessionId, totalCostUsd: this.accumulatedCostUsd });
  }

  private connect(resume: string | undefined, hasReconnected: boolean): void {
    this.input = new AsyncQueue<SDKUserMessage>();
    const query = this.deps.queryFn({
      prompt: this.input,
      options: { ...this.deps.baseOptions, ...(resume === undefined ? {} : { resume }), canUseTool: this.canUseTool },
    });
    this.query = query;
    void this.consume(query, createEventMapper(this.accumulatedCostUsd), hasReconnected);
  }

  private deliver(text: string): void {
    this.busy = true;
    this.input.push(toUserMessage(text));
  }

  private async consume(
    query: SessionQuery,
    mapEvents: (message: SDKMessage) => UiEvent[],
    hasReconnected: boolean,
  ): Promise<void> {
    try {
      for await (const message of query) {
        if (message.type === "system" && message.subtype === "init") {
          this.currentSessionId = message.session_id;
        }
        for (const event of mapEvents(message)) {
          this.handleEvent(event);
        }
      }
      if (!this.closed) {
        this.handleConnectionLost(new Error("SDK 연결이 종료되었습니다"), hasReconnected);
      }
    } catch (error) {
      if (!this.closed) {
        this.handleConnectionLost(error, hasReconnected);
      }
    }
  }

  private handleEvent(event: UiEvent): void {
    if (event.type === "turn_result") {
      this.accumulatedCostUsd = event.totalCostUsd;
      this.busy = false;
    }
    this.emit(event);
    if (event.type === "turn_result") {
      const next = this.pendingInputs.shift();
      if (next !== undefined) {
        this.deliver(next);
      }
    }
  }

  private handleConnectionLost(error: unknown, hasReconnected: boolean): void {
    const hadPendingInputs = this.pendingInputs.length > 0;
    this.pendingInputs.length = 0;
    this.busy = false;

    const canReconnect = !hasReconnected && this.currentSessionId !== undefined;
    const suffix = canReconnect && hadPendingInputs ? ` (${PENDING_CANCELLED_MESSAGE})` : "";
    this.emit({ type: "error", message: `${errorText(error)}${suffix}` });

    if (canReconnect) {
      this.connect(this.currentSessionId, true);
      return;
    }
    void this.close();
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, { signal }): Promise<PermissionResult> => {
    if (this.alwaysAllowedTools.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    const decision = await this.deps.prompter({ toolName, summary: summarizeToolInput(toolName, input), signal });
    if (decision === "deny") {
      return { behavior: "deny", message: DENIED_MESSAGE };
    }
    if (decision === "always") {
      this.alwaysAllowedTools.add(toolName);
    }
    return { behavior: "allow", updatedInput: input };
  };

  private emit(event: UiEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
