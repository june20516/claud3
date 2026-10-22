import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HISTORY_SIZE, createHistorySaver, loadHistory } from "../src/inputHistory.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claud3-history-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadHistory", () => {
  it("파일 경로가 없거나 파일이 없으면 빈 배열이다", () => {
    expect(loadHistory(undefined)).toEqual([]);
    expect(loadHistory(join(dir, "none"))).toEqual([]);
  });

  it("빈 줄은 제외하고 첫 줄부터 읽는다", () => {
    const file = join(dir, "history");
    writeFileSync(file, "latest\n\nolder\n");

    expect(loadHistory(file)).toEqual(["latest", "older"]);
  });

  it(`최대 ${HISTORY_SIZE}개까지만 읽는다`, () => {
    const file = join(dir, "history");
    const lines = Array.from({ length: HISTORY_SIZE + 10 }, (_, index) => `line ${index}`);
    writeFileSync(file, `${lines.join("\n")}\n`);

    expect(loadHistory(file)).toEqual(lines.slice(0, HISTORY_SIZE));
  });
});

describe("createHistorySaver", () => {
  it("연속으로 두 번 저장하면 마지막 내용이 남고 권한은 0600이다", async () => {
    const file = join(dir, "nested", "history");
    const save = createHistorySaver(file, vi.fn());

    save(["a"]);
    save(["b", "a"]);

    await vi.waitFor(() => expect(readFileSync(file, "utf8")).toBe("b\na\n"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("쓰기 실패는 처음 한 번만 onError로 알린다", async () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    const onError = vi.fn();
    const save = createHistorySaver(join(blocker, "history"), onError);

    save(["a"]);
    save(["b", "a"]);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
