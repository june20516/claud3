import type { CanUseTool, ModelInfo, Options, PermissionMode, PermissionResult, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "./asyncQueue.js";
import { createEventMapper, summarizeToolInput } from "./events.js";
import type { PermissionPrompter, UiEvent } from "./types.js";

/** Session이 쓰는 query 기능만 추린 타입. SDK의 Query도 이 타입을 만족한다. */
export type SessionQuery = AsyncIterable<SDKMessage> & {
  interrupt(): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  supportedModels(): Promise<ModelInfo[]>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
};

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => SessionQuery;

export interface SessionDeps {
  queryFn: QueryFn;
  baseOptions: Options;
  prompter: PermissionPrompter;
  resume?: string;
}

const DENIED_MESSAGE = "사용자가 거부했습니다";
const BUSY_MESSAGE = "턴이 끝난 뒤 다시 입력해 주세요";
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
  private currentModelName: string | undefined;
  private currentPermissionModeValue: PermissionMode | undefined;
  /** SDK에 보낸 뒤 아직 끝나지 않은 권한 모드 변경 수. 0이 아니면 SDK 보고값을 무시한다. */
  private inFlightModeChanges = 0;

  constructor(private readonly deps: SessionDeps) {
    this.currentSessionId = deps.resume;
    this.currentModelName = deps.baseOptions.model;
    this.currentPermissionModeValue = deps.baseOptions.permissionMode;
  }

  get currentPermissionMode(): PermissionMode | undefined {
    return this.currentPermissionModeValue;
  }

  get currentModel(): string | undefined {
    return this.currentModelName;
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

  async setModel(model: string): Promise<void> {
    this.assertIdle();
    if (!this.query) {
      throw new Error("세션이 시작되지 않았습니다");
    }
    await this.query.setModel(model);
    this.currentModelName = model;
  }

  /** 권한 모드를 바꾼다. SDK 실패는 reject하지 않고 값을 되돌린 뒤 이벤트로 알린다. */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.closed) {
      throw new Error("세션이 이미 종료되었습니다");
    }
    const previous = this.currentPermissionModeValue;
    if (previous === mode) {
      return;
    }
    this.currentPermissionModeValue = mode;
    this.emit({ type: "permission_mode", mode });
    const query = this.query;
    if (!query) {
      return; // 시작 전에는 값만 저장하고 connect가 options로 넘긴다.
    }
    this.inFlightModeChanges += 1;
    try {
      await query.setPermissionMode(mode);
    } catch (error) {
      // 더 새로운 요청이 현재 값을 바꿨다면 되돌리지 않는다.
      if (this.currentPermissionModeValue === mode) {
        this.currentPermissionModeValue = previous;
        this.emit({ type: "permission_mode", mode: previous ?? "default" });
      }
      this.emit({ type: "error", message: `권한 모드를 바꾸지 못했습니다: ${errorText(error)}` });
    } finally {
      this.inFlightModeChanges -= 1;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.query) {
      throw new Error("세션이 시작되지 않았습니다");
    }
    return this.query.supportedModels();
  }

  /** 현재 입력 대기열을 닫고 새 query를 연다. resume이 없으면 새 대화, 있으면 그 세션으로 이동한다. */
  async replace(resume?: string): Promise<void> {
    this.assertIdle();
    if (this.closed) {
      throw new Error("세션이 이미 종료되었습니다");
    }
    this.input.close();
    this.pendingInputs.length = 0;
    this.accumulatedCostUsd = 0;
    this.currentSessionId = resume;
    this.connect(resume, false);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.input.close();
    this.emit({ type: "session_closed", sessionId: this.currentSessionId, totalCostUsd: this.accumulatedCostUsd });
  }

  private assertIdle(): void {
    if (this.busy) {
      throw new Error(BUSY_MESSAGE);
    }
  }

  private connect(resume: string | undefined, hasReconnected: boolean): void {
    this.input = new AsyncQueue<SDKUserMessage>();
    const query = this.deps.queryFn({
      prompt: this.input,
      options: {
        ...this.deps.baseOptions,
        ...(this.currentModelName === undefined ? {} : { model: this.currentModelName }),
        ...(this.currentPermissionModeValue === undefined ? {} : { permissionMode: this.currentPermissionModeValue }),
        ...(resume === undefined ? {} : { resume }),
        canUseTool: this.canUseTool,
      },
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
        if (this.query !== query) {
          return; // replace로 교체된 query의 메시지는 버린다.
        }
        if (message.type === "system" && message.subtype === "init") {
          this.currentSessionId = message.session_id;
          this.currentModelName = message.model;
        }
        if (message.type === "system" && (message.subtype === "init" || message.subtype === "status")) {
          this.applyReportedPermissionMode(message.permissionMode);
        }
        for (const event of mapEvents(message)) {
          this.handleEvent(event);
        }
      }
      if (!this.closed && this.query === query) {
        this.handleConnectionLost(new Error("SDK 연결이 종료되었습니다"), hasReconnected);
      }
    } catch (error) {
      if (!this.closed && this.query === query) {
        this.handleConnectionLost(error, hasReconnected);
      }
    }
  }

  private applyReportedPermissionMode(reported: PermissionMode | undefined): void {
    if (reported === undefined || this.inFlightModeChanges > 0 || reported === this.currentPermissionModeValue) {
      return;
    }
    const hadValue = this.currentPermissionModeValue !== undefined;
    this.currentPermissionModeValue = reported;
    if (hadValue) {
      this.emit({ type: "permission_mode", mode: reported });
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
