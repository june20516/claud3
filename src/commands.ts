import type { Session } from "./session.js";
import { remainingCreditUsd } from "./usageStore.js";
import type { UsageSnapshot } from "./usageStore.js";

const COMMAND_NAMES = ["cost", "clear", "model", "resume", "help"] as const;
type CommandName = (typeof COMMAND_NAMES)[number];

export type ParsedInput =
  | { kind: "command"; name: CommandName; argument: string }
  | { kind: "prompt"; text: string };

export interface CommandContext {
  session: Pick<
    Session,
    "isBusy" | "totalCostUsd" | "currentModel" | "sessionId" | "setModel" | "listModels" | "replace"
  >;
  readUsage: () => Promise<UsageSnapshot>;
  print: (text: string) => void;
}

const BUSY_MESSAGE = "턴이 끝난 뒤 다시 입력해 주세요";
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_HINT = "바꾸려면: /model <ID>";

export const HELP_TEXT = [
  "명령",
  "  /cost            이번 세션 비용, 전체 누적 비용, 남은 크레딧 추정",
  "  /model           현재 모델과 쓸 수 있는 모델 목록",
  "  /model <ID>      모델 바꾸기 (예: /model claude-sonnet-5-5). 바꾼 뒤 첫 턴은 캐시가 새로 만들어져 비쌉니다",
  "  /clear           새 대화 시작",
  "  /resume <ID>     이전 세션으로 이동 (종료할 때 세션 ID가 출력됩니다)",
  "  /help            이 도움말",
  "  그 밖의 /…       플러그인 스킬 등으로 Claude에게 그대로 전달 (예: /suberpower:brainstorming)",
  "키",
  "  Enter            보내기 · 줄 끝에 \\ 를 붙이고 Enter: 여러 줄 입력",
  "  ↑/↓              이전 입력",
  "  Esc / Ctrl+C     실행 중인 턴 중단 · 권한 질문 중 Ctrl+C는 거부",
  "  Ctrl+C 두 번     종료 · Ctrl+D 종료",
  "권한 질문",
  "  y 이번만 허용 · n 거부 · a 이 도구는 세션 동안 항상 허용",
  "실행 옵션 (터미널에서)",
  "  claud3 --model <ID>      모델 지정해 시작",
  "  claud3 --resume <ID>     세션 이어서 시작",
  "  claud3 --help · --version",
  "개발판·안정판",
  "  claud3                  안정판 (승격한 커밋으로 고정)",
  "  npm run dev -- [옵션]   저장소에서 개발판 실행",
  '  승격은 Claude에게 "안정판으로 승격해 줘"처럼 요청 (npm run promote)',
].join("\n");

function isCommandName(name: string): name is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(name);
}

/** 앞뒤 공백을 제거한 뒤 내장 명령인지 판정한다. 그 밖의 입력은 Claude에게 보낼 prompt다. */
export function parseInput(line: string): ParsedInput {
  const text = line.trim();
  if (text.startsWith("/")) {
    const [name = "", ...rest] = text.slice(1).split(/\s+/);
    if (isCommandName(name)) {
      return { kind: "command", name, argument: rest.join(" ") };
    }
  }
  return { kind: "prompt", text };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function formatModelList(session: CommandContext["session"]): Promise<string> {
  const lines = [`현재 모델: ${session.currentModel ?? "기본값"}`];
  try {
    for (const model of await session.listModels()) {
      const marker = model.value === session.currentModel ? "*" : " ";
      lines.push(`${marker} ${model.value}  ${model.displayName} — ${model.description}`);
    }
  } catch (error) {
    lines.push(`모델 목록을 가져오지 못했습니다: ${errorText(error)}`);
  }
  lines.push(MODEL_HINT);
  return lines.join("\n");
}

async function formatCost({ session, readUsage }: CommandContext): Promise<string> {
  const usage = await readUsage();
  return (
    `세션 $${session.totalCostUsd.toFixed(4)} · 전체 누적 $${usage.spentUsd.toFixed(4)} · ` +
    `남은 크레딧 추정 $${remainingCreditUsd(usage).toFixed(2)} (정확한 값은 Console)`
  );
}

/** 상태를 바꾸는 동작을 실행하고 성공 문구를 돌려준다. busy면 실행하지 않고 안내 문구를 돌려준다. */
async function runMutation(
  context: CommandContext,
  action: () => Promise<void>,
  successMessage: string,
): Promise<string> {
  if (context.session.isBusy) {
    return BUSY_MESSAGE;
  }
  try {
    await action();
    return successMessage;
  } catch (error) {
    return errorText(error);
  }
}

function withPreviousSession(message: string, previousSessionId: string | undefined): string {
  return previousSessionId === undefined ? message : `${message} (이전 세션: ${previousSessionId})`;
}

export async function runCommand(
  command: Extract<ParsedInput, { kind: "command" }>,
  context: CommandContext,
): Promise<void> {
  const { session, print } = context;
  const { argument } = command;

  switch (command.name) {
    case "cost":
      print(await formatCost(context));
      return;
    case "help":
      print(HELP_TEXT);
      return;
    case "clear": {
      const previousSessionId = session.sessionId;
      print(
        await runMutation(
          context,
          () => session.replace(),
          withPreviousSession("새 대화를 시작했습니다", previousSessionId),
        ),
      );
      return;
    }
    case "model":
      if (argument === "") {
        print(await formatModelList(session));
        return;
      }
      print(await runMutation(context, () => session.setModel(argument), `모델을 ${argument}(으)로 바꿨습니다`));
      return;
    case "resume":
      if (argument === "") {
        print(`사용법: /resume <session-id>  (현재 세션: ${session.sessionId ?? "없음"})`);
        return;
      }
      if (!SESSION_ID_PATTERN.test(argument)) {
        print(`세션 ID 형식이 아닙니다: ${argument}`);
        return;
      }
      {
        const previousSessionId = session.sessionId;
        print(
          await runMutation(
            context,
            () => session.replace(argument),
            withPreviousSession(`세션 ${argument}(으)로 이동했습니다`, previousSessionId),
          ),
        );
      }
      return;
  }
}
