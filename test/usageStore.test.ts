import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addUsage, readUsage, remainingCreditUsd } from "../src/usageStore.js";

const DEFAULT_SNAPSHOT = { startingCreditUsd: 100, spentUsd: 0 };

describe("usageStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claud3-usage-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("파일이 없으면 기본값을 반환한다", async () => {
    expect(await readUsage(dir)).toEqual(DEFAULT_SNAPSHOT);
  });

  it("JSON이 깨졌으면 기본값을 반환한다", async () => {
    await writeFile(join(dir, "usage.json"), "{ 깨진", "utf8");
    expect(await readUsage(dir)).toEqual(DEFAULT_SNAPSHOT);
  });

  it("addUsage를 두 번 호출하면 누적되고 파일에 기록된다", async () => {
    await addUsage(0.5, dir);
    const snapshot = await addUsage(0.5, dir);
    expect(snapshot.spentUsd).toBe(1.0);

    const saved = JSON.parse(await readFile(join(dir, "usage.json"), "utf8"));
    expect(saved).toEqual({ startingCreditUsd: 100, spentUsd: 1.0 });
  });

  it("다른 쪽에서 파일을 바꿨으면 바뀐 값에 더한다", async () => {
    await addUsage(0.5, dir);
    await writeFile(join(dir, "usage.json"), JSON.stringify({ startingCreditUsd: 100, spentUsd: 10 }), "utf8");
    const snapshot = await addUsage(0.25, dir);
    expect(snapshot.spentUsd).toBe(10.25);
  });

  it("디렉터리가 없으면 만든다", async () => {
    const nested = join(dir, "a", "b");
    await addUsage(1, nested);
    expect((await readUsage(nested)).spentUsd).toBe(1);
  });

  it("남은 크레딧은 0 아래로 내려가지 않는다", () => {
    expect(remainingCreditUsd({ startingCreditUsd: 100, spentUsd: 120 })).toBe(0);
    expect(remainingCreditUsd({ startingCreditUsd: 100, spentUsd: 30 })).toBe(70);
  });
});
