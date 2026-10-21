#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MissingApiKeyError, readApiKey } from "./auth.js";
import { buildBaseOptions } from "./config.js";
import { Session } from "./session.js";
import { createPlainUi } from "./ui/plain.js";

export interface CliArgs {
  resume?: string;
  model?: string;
  help: boolean;
  version: boolean;
}

const USAGE = `사용법: claud3 [옵션]

Claude Agent SDK로 실행하는 터미널 코딩 CLI입니다. API 키는 macOS 키체인 'anthropic-api'에서 읽습니다.

옵션:
  --resume <id>   이전 세션을 이어서 실행
  --model <name>  사용할 모델 (예: claude-sonnet-5-5)
  -v, --version   버전 출력
  -h, --help      이 도움말 출력

조작:
  Esc / Ctrl+C    실행 중인 턴 중단 (권한 질문 중 Ctrl+C는 거부)
  Ctrl+C 두 번    종료
  Ctrl+D          종료`;

export function readVersion(): string {
  const packageJsonUrl = new URL("../package.json", import.meta.url);
  const { version } = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version: string };
  return version;
}

export function parseArgs(argv: string[]): CliArgs {
  const { values } = parseNodeArgs({
    args: argv,
    options: {
      resume: { type: "string" },
      model: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    help: values.help ?? false,
    version: values.version ?? false,
    ...(values.resume === undefined ? {} : { resume: values.resume }),
    ...(values.model === undefined ? {} : { model: values.model }),
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

  const baseOptions = buildBaseOptions({ cwd: process.cwd(), apiKey, model: args.model });
  const ui = createPlainUi({ input: process.stdin, output: process.stdout });
  const session = new Session({ queryFn: query, baseOptions, prompter: ui.prompter, resume: args.resume });
  await ui.run(session);
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
