import type { CommandContext } from "../commands.js";
import type { PersonaRuntime } from "../persona/runtime.js";
import type { Session } from "../session.js";
import type { PermissionPrompter, UserQuestionPrompter } from "../types.js";
import type { UsageSnapshot } from "../usageStore.js";
import type { WorkspaceInfo } from "../workspaceInfo.js";

/** 화면이 공통으로 받는 실행 옵션. print는 화면이 직접 제공한다. */
export interface UiRunOptions {
  /** print·pickSession·askQuestions·commandSignal은 화면이 직접 제공한다. */
  commandContext: Omit<CommandContext, "print" | "pickSession" | "askQuestions" | "commandSignal">;
  /** 시작하자마자 실행할 명령 (값 없는 --resume이면 "/resume"). */
  startupCommand?: string;
  /** 상태 줄에 보일 현재 디렉터리와 git 브랜치. 시작할 때와 턴이 끝날 때마다 다시 읽는다. */
  readWorkspace?: () => Promise<WorkspaceInfo>;
  recordUsage: (costUsd: number) => Promise<UsageSnapshot>;
  /** --persona로 켠 인격. 화면이 구독해 캐릭터 패널을 그린다. */
  persona?: Pick<PersonaRuntime, "snapshot" | "subscribe">;
}

export interface ChatUi {
  prompter: PermissionPrompter;
  /** AskUserQuestion 도구의 질문에 답을 받는다. */
  asker: UserQuestionPrompter;
  run(session: Session, options: UiRunOptions): Promise<void>;
}
