import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { isMissingFile, personasDir, writeJsonAtomically } from "../store.js";
import { emptyMemoryFile, mergeMemoryFiles, parseMemoryFile } from "./experience.js";
import type { MemoryFile } from "./experience.js";

const MEMORIES_SUFFIX = ".memories.json";
const BROKEN_MEMORIES_WARNING = "기억 파일이 깨져 새로 시작합니다";

export function memoriesPath(name: string, dir: string = personasDir()): string {
  return join(dir, `${name}${MEMORIES_SUFFIX}`);
}

/** 파일이 없으면 undefined. JSON·형식이 깨졌으면 "broken". */
async function readMemoryFile(filePath: string): Promise<MemoryFile | "broken" | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
  try {
    return parseMemoryFile(JSON.parse(raw)) ?? "broken";
  } catch {
    return "broken";
  }
}

/** 디스크의 현재 기억. 없거나 깨졌으면 undefined이고 파일을 옮기지 않는다. */
export async function readMemories(name: string, dir: string = personasDir()): Promise<MemoryFile | undefined> {
  const file = await readMemoryFile(memoriesPath(name, dir));
  return file === "broken" ? undefined : file;
}

/** 없으면 빈 기억, 깨졌으면 .broken으로 옮기고 경고와 함께 빈 기억. */
export async function loadMemories(
  name: string,
  dir: string = personasDir(),
): Promise<{ file: MemoryFile; warning?: string }> {
  const filePath = memoriesPath(name, dir);
  const file = await readMemoryFile(filePath);
  if (file === undefined) {
    return { file: emptyMemoryFile() };
  }
  if (file === "broken") {
    await rename(filePath, `${filePath}.broken`);
    return { file: emptyMemoryFile(), warning: BROKEN_MEMORIES_WARNING };
  }
  return { file };
}

/**
 * 저장 직전에 디스크 파일을 다시 읽어 합친 뒤 쓴다. 같은 인격으로 claud3를 두 개 띄워도 서로의 기록을 지우지 않는다.
 * 디스크 파일이 없거나 깨졌으면 합치지 않는다. 합친 결과를 돌려준다.
 */
export async function saveMemories(name: string, file: MemoryFile, dir: string = personasDir()): Promise<MemoryFile> {
  const filePath = memoriesPath(name, dir);
  const onDisk = await readMemoryFile(filePath);
  const merged = onDisk === undefined || onDisk === "broken" ? file : mergeMemoryFiles(onDisk, file);
  await writeJsonAtomically(filePath, merged);
  return merged;
}
