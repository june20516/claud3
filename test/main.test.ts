import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseArgs, readVersion, shouldUsePlainUi } from "../src/main.js";

const packageVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

describe("shouldUsePlainUi", () => {
  it("--plain이 없고 입출력이 모두 터미널이면 Ink 화면", () => {
    expect(shouldUsePlainUi({ plain: false, stdinIsTty: true, stdoutIsTty: true })).toBe(false);
  });

  it("--plain이면 readline 화면", () => {
    expect(shouldUsePlainUi({ plain: true, stdinIsTty: true, stdoutIsTty: true })).toBe(true);
  });

  it("입력이 터미널이 아니면 readline 화면", () => {
    expect(shouldUsePlainUi({ plain: false, stdinIsTty: false, stdoutIsTty: true })).toBe(true);
  });

  it("출력이 터미널이 아니면 readline 화면", () => {
    expect(shouldUsePlainUi({ plain: false, stdinIsTty: true, stdoutIsTty: false })).toBe(true);
  });
});

describe("parseArgs", () => {
  it("--resume와 --model 값을 읽는다", () => {
    expect(parseArgs(["--resume", "abc", "--model", "claude-sonnet-5-5"])).toEqual({
      resume: "abc",
      model: "claude-sonnet-5-5",
      help: false,
      version: false,
      plain: false,
    });
  });

  it("인자가 없으면 help=false, version=false, plain=false만", () => {
    expect(parseArgs([])).toEqual({ help: false, version: false, plain: false });
  });

  it("--plain은 plain=true", () => {
    expect(parseArgs(["--plain"]).plain).toBe(true);
  });

  it("--help와 -h", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("값 없는 --resume는 세션 목록에서 고르기다", () => {
    expect(parseArgs(["--resume"])).toEqual({ pickResume: true, help: false, version: false, plain: false });
    expect(parseArgs(["--resume", "--plain"])).toEqual({ pickResume: true, help: false, version: false, plain: true });
    expect(parseArgs(["--resume", "abc"]).pickResume).toBeUndefined();
  });

  it("알 수 없는 옵션은 오류를 던진다", () => {
    expect(() => parseArgs(["--unknown"])).toThrow();
  });

  it("--version", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
  });

  it("--permission-mode 값을 읽는다", () => {
    expect(parseArgs(["--permission-mode", "plan"]).permissionMode).toBe("plan");
  });

  it("잘못된 --permission-mode는 잘못된 이름 문구로 던진다", () => {
    expect(() => parseArgs(["--permission-mode", "Plan"])).toThrow(
      "알 수 없는 권한 모드: Plan (default, acceptEdits, plan, auto)",
    );
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

describe("claud3 --permission-mode", () => {
  it("잘못된 값이면 종료 코드 1과 잘못된 이름 문구를 stderr에 출력한다", () => {
    const result = spawnSync("node_modules/.bin/tsx", ["src/main.ts", "--permission-mode", "bogus"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("알 수 없는 권한 모드: bogus (default, acceptEdits, plan, auto)");
  });
});
