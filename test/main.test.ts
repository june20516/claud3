import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseArgs, readVersion } from "../src/main.js";

const packageVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

describe("parseArgs", () => {
  it("--resume와 --model 값을 읽는다", () => {
    expect(parseArgs(["--resume", "abc", "--model", "claude-sonnet-5-5"])).toEqual({
      resume: "abc",
      model: "claude-sonnet-5-5",
      help: false,
      version: false,
    });
  });

  it("인자가 없으면 help=false만", () => {
    expect(parseArgs([])).toEqual({ help: false, version: false });
  });

  it("--help와 -h", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("값 없는 --resume는 오류를 던진다", () => {
    expect(() => parseArgs(["--resume"])).toThrow();
  });

  it("알 수 없는 옵션은 오류를 던진다", () => {
    expect(() => parseArgs(["--unknown"])).toThrow();
  });

  it("--version", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
  });
});

describe("readVersion", () => {
  it("package.json의 version을 돌려준다", () => {
    expect(readVersion()).toBe(packageVersion);
  });
});

describe("claud3 --version", () => {
  it("version을 출력하고 종료 코드 0으로 끝난다", () => {
    const result = spawnSync("node_modules/.bin/tsx", ["src/main.ts", "--version"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(packageVersion);
  });
});
