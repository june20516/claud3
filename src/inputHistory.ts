import { readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const HISTORY_SIZE = 500;
const HISTORY_FILE_MODE = 0o600;

/** 기록 파일을 읽는다. 첫 줄이 가장 최근 입력. 파일이 없거나 읽을 수 없으면 빈 기록으로 시작한다. */
export function loadHistory(historyFile: string | undefined): string[] {
  if (historyFile === undefined) {
    return [];
  }
  try {
    return readFileSync(historyFile, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .slice(0, HISTORY_SIZE);
  } catch {
    return [];
  }
}

/** 저장이 겹치지 않도록 차례로 쓰고(권한 0600), 실패는 처음 한 번만 onError로 알린다. */
export function createHistorySaver(file: string, onError: (error: unknown) => void): (history: string[]) => void {
  let historyWrites: Promise<void> = Promise.resolve();
  let hasWarned = false;
  return (history) => {
    const content = `${history.slice(0, HISTORY_SIZE).join("\n")}\n`;
    historyWrites = historyWrites
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content, { encoding: "utf8", mode: HISTORY_FILE_MODE });
        await chmod(file, HISTORY_FILE_MODE);
      })
      .catch((error: unknown) => {
        if (!hasWarned) {
          hasWarned = true;
          onError(error);
        }
      });
  };
}
