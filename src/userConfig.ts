import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePermissionMode, unknownPermissionModeMessage } from "./permissionModes.js";
import type { SelectablePermissionMode } from "./permissionModes.js";
import { configDir } from "./usageStore.js";

const CONFIG_FILE_NAME = "config.json";

/** claud3 전용 설정. Claude Code 설정(~/.claude)과 따로 둔다. */
export interface UserConfig {
  /** 시작 권한 모드. --permission-mode가 있으면 그쪽이 우선한다. */
  permissionMode?: SelectablePermissionMode;
}

export interface UserConfigResult {
  config: UserConfig;
  /** 읽었지만 쓰지 못한 값에 대한 안내. 설정이 틀려도 실행은 계속한다. */
  warnings: string[];
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** `<설정 디렉터리>/config.json`을 읽는다. 파일이 없으면 빈 설정이다. */
export async function readUserConfig(dir: string = configDir()): Promise<UserConfigResult> {
  const filePath = join(dir, CONFIG_FILE_NAME);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return { config: {}, warnings: [] };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config: {}, warnings: [`${filePath}: JSON 형식이 아닙니다`] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { config: {}, warnings: [`${filePath}: JSON 객체가 아닙니다`] };
  }

  const { permissionMode } = parsed as Record<string, unknown>;
  if (permissionMode === undefined) {
    return { config: {}, warnings: [] };
  }
  const mode = typeof permissionMode === "string" ? parsePermissionMode(permissionMode) : undefined;
  if (mode === undefined) {
    return { config: {}, warnings: [`${filePath}: ${unknownPermissionModeMessage(String(permissionMode))}`] };
  }
  return { config: { permissionMode: mode }, warnings: [] };
}

/** 실행 옵션, 설정 파일 순으로 정한다. 둘 다 없으면 SDK가 Claude Code 설정의 defaultMode를 따른다. */
export function resolvePermissionMode(
  cliMode: SelectablePermissionMode | undefined,
  config: UserConfig,
): SelectablePermissionMode | undefined {
  return cliMode ?? config.permissionMode;
}
