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

  it("JSON 문자열 줄은 풀어서 읽어 줄바꿈이 든 입력을 되살리고, 예전 형식 줄은 그대로 읽는다", () => {
    const file = join(dir, "history");
    writeFileSync(file, `${JSON.stringify("첫 줄\n둘째 줄")}\n예전 입력\n"따옴표로 시작하는 예전 입력\n`);

    expect(loadHistory(file)).toEqual(["첫 줄\n둘째 줄", "예전 입력", '"따옴표로 시작하는 예전 입력']);
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

    await vi.waitFor(() => expect(readFileSync(file, "utf8")).toBe('"b"\n"a"\n'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("줄바꿈이 든 입력도 한 줄로 저장하고 loadHistory로 그대로 되살린다", async () => {
    const file = join(dir, "history");
    const history = ["첫 줄\n둘째 줄", 'a "따옴표" \\ 역슬래시'];
    createHistorySaver(file, vi.fn())(history);

    await vi.waitFor(() => expect(readFileSync(file, "utf8").split("\n")).toHaveLength(3));
    expect(loadHistory(file)).toEqual(history);
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
