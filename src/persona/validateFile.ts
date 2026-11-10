import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { validateProfile } from "./profile.js";

/** 0: 유효함, 1: 스키마 위반·이름 불일치, 2: 파일 없음·읽기 실패·JSON 형식 오류. */
export type PersonaFileExitCode = 0 | 1 | 2;

export interface PersonaFileCheck {
  exitCode: PersonaFileExitCode;
  /** stderr에 그대로 쓸 줄. 종료 코드 1이면 `<path>: <message>` 형식이다. */
  errors: string[];
}

const PROFILE_SUFFIX = ".json";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function singleLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ");
}

/** --persona <name>은 <name>.json을 찾으므로 파일 이름과 name이 같아야 그 이름으로 열린다. */
function nameMismatchError(filePath: string, name: unknown): string | undefined {
  const fileName = basename(filePath, PROFILE_SUFFIX);
  if (typeof name !== "string" || name === fileName) {
    return undefined;
  }
  return `name: 파일 이름(${fileName})과 name(${name})이 다릅니다. --persona는 <name>.json을 찾습니다`;
}

/** 인격 파일을 loadProfile과 같은 규칙으로 검사한다. API 키·SDK·네트워크를 쓰지 않는다. */
export async function validatePersonaFile(filePath: string): Promise<PersonaFileCheck> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const description = isMissingFile(error)
      ? `파일이 없습니다: ${filePath}`
      : `파일을 읽지 못했습니다: ${filePath} (${singleLine(errorMessage(error))})`;
    return { exitCode: 2, errors: [description] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { exitCode: 2, errors: [`JSON 형식 오류: ${filePath} (${singleLine(errorMessage(error))})`] };
  }

  const validation = validateProfile(parsed);
  const errors = validation.ok ? [] : validation.issues.map((issue) => `${issue.path}: ${issue.message}`);
  const name = typeof parsed === "object" && parsed !== null && "name" in parsed ? parsed.name : undefined;
  const mismatch = nameMismatchError(filePath, name);
  if (mismatch !== undefined) {
    errors.push(mismatch);
  }
  return errors.length === 0 ? { exitCode: 0, errors } : { exitCode: 1, errors };
}
