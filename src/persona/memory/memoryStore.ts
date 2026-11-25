import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isMissingFile, personasDir, writeJsonAtomically } from "../store.js";
import { emptyMemoryFile, mergeMemoryFiles, parseMemoryFile, trimSessions } from "./experience.js";
import type { MemoryFile } from "./experience.js";

const MEMORIES_SUFFIX = ".memories.json";
const BROKEN_MEMORIES_WARNING = "기억 파일이 깨져 새로 시작합니다";
/** 잠금을 기다리는 최대 시간. 넘기면 저장 실패로 처리해 다음 기록 때 다시 시도한다. */
const LOCK_WAIT_MS = 3_000;
const LOCK_RETRY_MS = 25;
/** 이보다 오래된 잠금은 죽은 프로세스가 남긴 것으로 보고 치운다(저장 한 번은 수 ms면 끝난다). */
const LOCK_STALE_MS = 10_000;

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS;
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * <파일>.lock 디렉터리로 잠그고 task를 실행한다. mkdir은 원자적이라 같은 인격의 다른 프로세스(와 같은 프로세스의
 * 다른 저장)가 "다시 읽기 → 합치기 → 쓰기" 사이에 끼어들지 못한다.
 */
async function withFileLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  await mkdir(dirname(filePath), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      if (await isStaleLock(lockPath)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("기억 파일 잠금을 얻지 못했습니다");
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await task();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

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
 * 잠근 채로 디스크 파일을 다시 읽어 합친 뒤 쓴다. 같은 인격으로 claud3를 두 개 띄워도 서로의 기록을 지우지 않는다.
 * 디스크 파일이 없거나 깨졌으면 합치지 않는다. 오래 못 읽은 세션은 디스크에서도 뺀다(합집합으로 되살아나지 않게).
 * 합친 결과를 돌려준다.
 */
export async function saveMemories(
  name: string,
  file: MemoryFile,
  dir: string = personasDir(),
  now: Date = new Date(),
): Promise<MemoryFile> {
  const filePath = memoriesPath(name, dir);
  return withFileLock(filePath, async () => {
    const onDisk = await readMemoryFile(filePath);
    const merged = onDisk === undefined || onDisk === "broken" ? file : mergeMemoryFiles(onDisk, file);
    const trimmed: MemoryFile = { ...merged, sessions: trimSessions(merged.sessions, now) };
    await writeJsonAtomically(filePath, trimmed);
    return trimmed;
  });
}
