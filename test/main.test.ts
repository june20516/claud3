import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/main.js";

describe("parseArgs", () => {
  it("--resume와 --model 값을 읽는다", () => {
    expect(parseArgs(["--resume", "abc", "--model", "claude-sonnet-5-5"])).toEqual({
      resume: "abc",
      model: "claude-sonnet-5-5",
      help: false,
    });
  });

  it("인자가 없으면 help=false만", () => {
    expect(parseArgs([])).toEqual({ help: false });
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
});
