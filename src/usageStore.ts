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

export async function addUsage(costUsd: number, dir: string = configDir()): Promise<UsageSnapshot> {
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
