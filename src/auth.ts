import { execFile } from "node:child_process";

const KEYCHAIN_SERVICE = "anthropic-api";

export type CommandRunner = (command: string, args: string[]) => Promise<{ exitCode: number; stdout: string }>;

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      [
        `macOS 키체인에서 API 키(서비스 이름 '${KEYCHAIN_SERVICE}')를 찾을 수 없습니다.`,
        "다음 명령으로 등록한 뒤 다시 실행해 주세요:",
        `  security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w`,
      ].join("\n"),
    );
    this.name = "MissingApiKeyError";
  }
}

const runCommand: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout) => {
      const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ exitCode, stdout });
    });
  });

export async function readApiKey(run: CommandRunner = runCommand): Promise<string> {
  const { exitCode, stdout } = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
  const apiKey = stdout.trim();
  if (exitCode !== 0 || apiKey === "") {
    throw new MissingApiKeyError();
  }
  return apiKey;
}
