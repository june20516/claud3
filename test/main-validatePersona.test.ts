import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readApiKey } from "../src/auth.js";
import { main, parseArgs } from "../src/main.js";

vi.mock("../src/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth.js")>()),
  readApiKey: vi.fn(async () => "test-key"),
}));

const fixtureText = await readFile(new URL("./fixtures/persona-rapi.json", import.meta.url), "utf8");

describe("parseArgs --validate-persona", () => {
  it("파일 경로를 읽는다", () => {
    expect(parseArgs(["--validate-persona", "a/rapi.json"]).validatePersona).toBe("a/rapi.json");
  });

  it("없으면 validatePersona 키가 없다", () => {
    expect("validatePersona" in parseArgs([])).toBe(false);
  });
});

describe("main --validate-persona", () => {
  let dir: string;
  let stderrLines: string[];
  let stdoutLines: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claud3-main-validate-"));
    stderrLines = [];
    stdoutLines = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => void stderrLines.push(String(line)));
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void stdoutLines.push(String(line)));
    vi.mocked(readApiKey).mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("유효한 파일이면 0, 출력 없음, API 키를 읽지 않는다", async () => {
    const filePath = join(dir, "rapi.json");
    await writeFile(filePath, fixtureText, "utf8");
    expect(await main(["--validate-persona", filePath])).toBe(0);
    expect(stderrLines).toEqual([]);
    expect(stdoutLines).toEqual([]);
    expect(readApiKey).not.toHaveBeenCalled();
  });

  it("필수 필드가 없으면 1, 문제마다 stderr 한 줄", async () => {
    const { summary: _summary, ...withoutSummary } = JSON.parse(fixtureText) as Record<string, unknown>;
    const filePath = join(dir, "rapi.json");
    await writeFile(filePath, JSON.stringify(withoutSummary), "utf8");
    expect(await main(["--validate-persona", filePath])).toBe(1);
    expect(stderrLines).toEqual(["summary: 문자열이어야 합니다"]);
    expect(readApiKey).not.toHaveBeenCalled();
  });

  it("파일 이름과 name이 다르면 1, name: 줄", async () => {
    const filePath = join(dir, "persona-rapi.json");
    await writeFile(filePath, fixtureText, "utf8");
    expect(await main(["--validate-persona", filePath])).toBe(1);
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toMatch(/^name: /);
  });

  it("없는 파일이면 2", async () => {
    expect(await main(["--validate-persona", join(dir, "missing.json")])).toBe(2);
    expect(stderrLines).toHaveLength(1);
    expect(readApiKey).not.toHaveBeenCalled();
  });

  it("깨진 JSON이면 2", async () => {
    const filePath = join(dir, "rapi.json");
    await writeFile(filePath, "{ broken", "utf8");
    expect(await main(["--validate-persona", filePath])).toBe(2);
    expect(stderrLines).toHaveLength(1);
  });
});
