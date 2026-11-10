import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validatePersonaFile } from "../src/persona/validateFile.js";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/persona-rapi.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

describe("validatePersonaFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claud3-validate-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeJson(fileName: string, value: unknown): Promise<string> {
    const filePath = join(dir, fileName);
    await writeFile(filePath, JSON.stringify(value), "utf8");
    return filePath;
  }

  it("유효한 파일은 종료 코드 0, 문제 없음", async () => {
    const filePath = await writeJson("rapi.json", fixture);
    expect(await validatePersonaFile(filePath)).toEqual({ exitCode: 0, errors: [] });
  });

  it("필수 필드가 없으면 종료 코드 1, 해당 path 줄", async () => {
    const { summary: _summary, ...withoutSummary } = fixture;
    const filePath = await writeJson("rapi.json", withoutSummary);
    expect(await validatePersonaFile(filePath)).toEqual({ exitCode: 1, errors: ["summary: 문자열이어야 합니다"] });
  });

  it("파일 이름과 name이 다르면 종료 코드 1, name 줄", async () => {
    const filePath = await writeJson("persona-rapi.json", fixture);
    const result = await validatePersonaFile(filePath);
    expect(result.exitCode).toBe(1);
    expect(result.errors).toEqual([
      "name: 파일 이름(persona-rapi)과 name(rapi)이 다릅니다. --persona는 <name>.json을 찾습니다",
    ]);
  });

  it("스키마 문제와 이름 불일치를 함께 보고한다", async () => {
    const filePath = await writeJson("other.json", { ...fixture, version: 2 });
    expect((await validatePersonaFile(filePath)).errors).toEqual([
      "version: 1이어야 합니다",
      "name: 파일 이름(other)과 name(rapi)이 다릅니다. --persona는 <name>.json을 찾습니다",
    ]);
  });

  it("name이 문자열이 아니면 스키마 문제만 보고한다", async () => {
    const filePath = await writeJson("rapi.json", { ...fixture, name: 3 });
    expect((await validatePersonaFile(filePath)).errors).toEqual(["name: 소문자·숫자·_·- 1~32자여야 합니다"]);
  });

  it("최상위가 객체가 아니면 종료 코드 1", async () => {
    const filePath = await writeJson("rapi.json", []);
    expect(await validatePersonaFile(filePath)).toEqual({ exitCode: 1, errors: [": 객체여야 합니다"] });
  });

  it("없는 파일은 종료 코드 2, 한 줄 설명", async () => {
    const filePath = join(dir, "missing.json");
    expect(await validatePersonaFile(filePath)).toEqual({ exitCode: 2, errors: [`파일이 없습니다: ${filePath}`] });
  });

  it("읽을 수 없는 경로(디렉터리)는 종료 코드 2", async () => {
    const result = await validatePersonaFile(dir);
    expect(result.exitCode).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`파일을 읽지 못했습니다: ${dir}`);
  });

  it("깨진 JSON은 종료 코드 2, 한 줄 설명", async () => {
    const filePath = join(dir, "rapi.json");
    await writeFile(filePath, "{ broken", "utf8");
    const result = await validatePersonaFile(filePath);
    expect(result.exitCode).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`JSON 형식 오류: ${filePath}`);
    expect(result.errors[0]).not.toContain("\n");
  });
});
