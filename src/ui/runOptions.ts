import type { CommandContext } from "../commands.js";
import type { Session } from "../session.js";
import type { PermissionPrompter, UserQuestionPrompter } from "../types.js";
import type { UsageSnapshot } from "../usageStore.js";

/** 화면이 공통으로 받는 실행 옵션. print는 화면이 직접 제공한다. */
export interface UiRunOptions {
  commandContext: Omit<CommandContext, "print">;
  recordUsage: (costUsd: number) => Promise<UsageSnapshot>;
}

export interface ChatUi {
  prompter: PermissionPrompter;
  /** AskUserQuestion 도구의 질문에 답을 받는다. */
  asker: UserQuestionPrompter;
  run(session: Session, options: UiRunOptions): Promise<void>;
}
