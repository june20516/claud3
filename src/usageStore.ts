import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE_FILE_NAME = "usage.json";
const DEFAULT_STARTING_CREDIT_USD = 100;

export interface UsageSnapshot {
  startingCreditUsd: number;
  spentUsd: number;
}

export function configDir(): string {
  return process.env.CLAUD3_CONFIG_DIR ?? join(homedir(), ".config", "claud3");
}

function defaultSnapshot(): UsageSnapshot {
  return { startingCreditUsd: DEFAULT_STARTING_CREDIT_USD, spentUsd: 0 };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseSnapshot(raw: string): UsageSnapshot {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const { startingCreditUsd, spentUsd } = parsed as Record<string, unknown>;
      if (isFiniteNumber(startingCreditUsd) && isFiniteNumber(spentUsd)) {
        return { startingCreditUsd, spentUsd };
      }
    }
  } catch {
    // 깨진 JSON은 기본값으로 취급한다.
  }
  return defaultSnapshot();
}

export async function readUsage(dir: string = configDir()): Promise<UsageSnapshot> {
  try {
    return parseSnapshot(await readFile(join(dir, USAGE_FILE_NAME), "utf8"));
  } catch {
    return defaultSnapshot();
  }
}

/** 읽고-더하고-쓰기가 겹치면 갱신이 사라지고 같은 임시 파일 이름이 충돌하므로 한 줄로 세운다. */
let writeQueue: Promise<unknown> = Promise.resolve();

export function addUsage(costUsd: number, dir: string = configDir()): Promise<UsageSnapshot> {
  const run = writeQueue.then(
    () => addUsageNow(costUsd, dir),
    () => addUsageNow(costUsd, dir),
  );
  writeQueue = run.catch(() => undefined);
  return run;
}

/** 기다리지 않는 기록(인격의 반응 판단·조사 비용). 실패하면 알리기만 하고 거부된 promise를 남기지 않는다. */
export async function recordUsageInBackground(
  costUsd: number,
  onError: (message: string) => void,
  dir: string = configDir(),
): Promise<void> {
  try {
    await addUsage(costUsd, dir);
  } catch (error) {
    onError(`사용량을 기록하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function addUsageNow(costUsd: number, dir: string): Promise<UsageSnapshot> {
  const current = await readUsage(dir);
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    return current;
  }
  const next: UsageSnapshot = { ...current, spentUsd: current.spentUsd + costUsd };

  await mkdir(dir, { recursive: true });
  const filePath = join(dir, USAGE_FILE_NAME);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(next, null, 2), "utf8");
  await rename(tempPath, filePath);
  return next;
}

export function remainingCreditUsd(snapshot: UsageSnapshot): number {
  return Math.max(0, snapshot.startingCreditUsd - snapshot.spentUsd);
}
