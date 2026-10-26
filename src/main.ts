#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MissingApiKeyError, readApiKey } from "./auth.js";
import { buildBaseOptions } from "./config.js";
import { parsePermissionMode, unknownPermissionModeMessage } from "./permissionModes.js";
import type { SelectablePermissionMode } from "./permissionModes.js";
import { Session } from "./session.js";
import { loadHistoryLines } from "./sessionHistory.js";
import { loadSessionList } from "./sessionList.js";
import { createInkUi } from "./ui/ink/index.js";
import { createPlainUi } from "./ui/plain.js";
import type { ChatUi } from "./ui/runOptions.js";
import { addUsage, configDir, readUsage } from "./usageStore.js";
import { readUserConfig, resolvePermissionMode } from "./userConfig.js";
import { readWorkspaceInfo } from "./workspaceInfo.js";

export interface CliArgs {
  resume?: string;
  /** 값 없는 --resume. 시작한 뒤 세션 목록에서 고른다. */
  pickResume?: boolean;
  model?: string;
  permissionMode?: SelectablePermissionMode;
  plain: boolean;
  help: boolean;
  version: boolean;
}

const USAGE = `사용법: claud3 [옵션]

Claude Agent SDK로 실행하는 터미널 코딩 CLI입니다. API 키는 macOS 키체인 'anthropic-api'에서 읽습니다.

옵션:
  --resume [id]   이전 세션을 이어서 실행 (id를 생략하면 세션 목록에서 고름)
  --model <name>  사용할 모델 (예: claude-sonnet-5-5)
  --permission-mode <mode>  권한 모드 (default, acceptEdits, plan, auto)
                  생략하면 ~/.config/claud3/config.json의 permissionMode, 없으면 Claude Code 설정
  --plain         readline 화면으로 시작 (기본은 Ink 화면)
  -v, --version   버전 출력
  -h, --help      이 도움말 출력

조작:
  Esc / Ctrl+C    실행 중인 턴 중단 (권한 질문 중 Ctrl+C는 거부)
  Ctrl+C 두 번    종료
  Ctrl+D          종료
  Shift+Tab       권한 모드 순환`;

export function readVersion(): string {
  const packageJsonUrl = new URL("../package.json", import.meta.url);
  const { version } = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version: string };
  return version;
}

/** Ink 화면은 입출력이 모두 터미널일 때만 쓴다. 나머지는 readline 화면으로 동작한다. */
export function shouldUsePlainUi(params: { plain: boolean; stdinIsTty: boolean; stdoutIsTty: boolean }): boolean {
  return params.plain || !params.stdinIsTty || !params.stdoutIsTty;
}

const RESUME_FLAG = "--resume";

/** 값 없이 쓴 --resume(맨 끝이거나 다음이 옵션)을 빼고, 있었는지 돌려준다. node의 parseArgs는 선택적 값을 지원하지 않는다. */
function extractBareResume(argv: string[]): { args: string[]; pickResume: boolean } {
  const index = argv.findIndex((arg, position) => arg === RESUME_FLAG && (argv[position + 1] ?? "-").startsWith("-"));
  if (index === -1) {
    return { args: argv, pickResume: false };
  }
  return { args: [...argv.slice(0, index), ...argv.slice(index + 1)], pickResume: true };
}

export function parseArgs(argv: string[]): CliArgs {
  const { args, pickResume } = extractBareResume(argv);
  const { values } = parseNodeArgs({
    args,
    options: {
      resume: { type: "string" },
      model: { type: "string" },
      "permission-mode": { type: "string" },
      plain: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const permissionModeValue = values["permission-mode"];
  const permissionMode = permissionModeValue === undefined ? undefined : parsePermissionMode(permissionModeValue);
  if (permissionModeValue !== undefined && permissionMode === undefined) {
    throw new Error(unknownPermissionModeMessage(permissionModeValue));
  }
  return {
    plain: values.plain ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
    ...(pickResume ? { pickResume } : {}),
    ...(values.resume === undefined ? {} : { resume: values.resume }),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
  };
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 1;
  }

  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  if (args.version) {
    console.log(readVersion());
    return 0;
  }

  let apiKey: string;
  try {
    apiKey = await readApiKey();
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  const { config: userConfig, warnings: configWarnings } = await readUserConfig();
  for (const warning of configWarnings) {
    console.error(`설정 무시: ${warning}`);
  }

  const baseOptions = buildBaseOptions({
    cwd: process.cwd(),
    apiKey,
    model: args.model,
    permissionMode: resolvePermissionMode(args.permissionMode, userConfig),
  });
  const historyFile = join(configDir(), "history");
  const ui: ChatUi =
    shouldUsePlainUi({
      plain: args.plain,
      stdinIsTty: process.stdin.isTTY === true,
      stdoutIsTty: process.stdout.isTTY === true,
    })
      ? createPlainUi({ input: process.stdin, output: process.stdout, historyFile })
      : createInkUi({ stdin: process.stdin, stdout: process.stdout, historyFile });
  const session = new Session({
    queryFn: query,
    baseOptions,
    prompter: ui.prompter,
    askUser: ui.asker,
    resume: args.resume,
    loadHistory: (sessionId) => loadHistoryLines(sessionId),
  });
  await ui.run(session, {
    commandContext: {
      session,
      readUsage: () => readUsage(),
      listSessions: () => loadSessionList({ cwd: process.cwd() }),
    },
    ...(args.pickResume === true ? { startupCommand: "/resume" } : {}),
    readWorkspace: () => readWorkspaceInfo({ cwd: process.cwd() }),
    recordUsage: (costUsd) => addUsage(costUsd),
  });
  return 0;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  // npm link로 설치하면 심볼릭 링크를 거쳐 실행되므로 실제 경로로 비교한다.
  return import.meta.url === pathToFileURL(realpathSync(entry)).href;
}

if (isEntryPoint()) {
  // SDK 하위 프로세스가 이벤트 루프를 붙잡지 않도록 끝나면 명시적으로 종료한다.
  main().then(
    (exitCode) => process.exit(exitCode),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
