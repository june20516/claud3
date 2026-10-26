import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIFF_MAX_LINES, formatToolDiff } from "../src/diffView.js";

const ADDED_BACKGROUND = "\u001b[48;5;22m";
const REMOVED_BACKGROUND = "\u001b[48;5;52m";
// 밝은 글자(256색 255). 기본 글자색에 맡기면 밝은 테마에서 검은 글자가 어두운 배경에 묻힌다.
const LIGHT_FOREGROUND = "\u001b[38;5;255m";
const RESET_FOREGROUND = "\u001b[39m";

describe("formatToolDiff 배경색", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function forceColor(): void {
    vi.stubEnv("FORCE_COLOR", "1");
    vi.stubEnv("NO_COLOR", "");
  }

  function rawLines(input: Record<string, unknown>, options?: { width?: number }): string[] {
    return (formatToolDiff("Edit", input, options) ?? "").split("\n");
  }

  it("추가 줄은 어두운 초록, 삭제 줄은 어두운 빨강 배경이고 문맥 줄에는 배경이 없다", () => {
    forceColor();
    const [context, removed, added] = rawLines({ old_string: "same\nold", new_string: "same\nnew" });

    expect(removed).toContain(REMOVED_BACKGROUND);
    expect(added).toContain(ADDED_BACKGROUND);
    expect(context).not.toContain(ADDED_BACKGROUND);
    expect(context).not.toContain(REMOVED_BACKGROUND);
  });

  it("추가·삭제 줄의 글자는 밝은색으로 명시하고 줄 끝에서 되돌린다", () => {
    forceColor();
    const [context, removed, added] = rawLines({ old_string: "same\nold", new_string: "same\nnew" });

    for (const line of [removed, added]) {
      expect(line).toContain(`${LIGHT_FOREGROUND}`);
      expect(line?.endsWith(RESET_FOREGROUND)).toBe(true);
    }
    expect(context).not.toContain(LIGHT_FOREGROUND);
  });

  it("폭을 주면 바뀐 줄의 배경을 그 폭 끝까지 채운다", () => {
    forceColor();
    const lines = rawLines({ old_string: "old", new_string: "새 줄" }, { width: 20 }).map((line) =>
      stripVTControlCharacters(line),
    );

    // "    + 새 줄"은 폭 11("새 줄"이 5칸)이므로 공백 9칸을 채운다.
    expect(lines).toEqual([`    - old${" ".repeat(11)}`, `    + 새 줄${" ".repeat(9)}`]);
  });

  it("색을 쓰지 않는 환경에서는 배경도 폭 채우기도 하지 않는다", () => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("FORCE_COLOR", "0");
    const lines = rawLines({ old_string: "old", new_string: "new" }, { width: 20 });

    expect(lines).toEqual(["    - old", "    + new"]);
  });
});

function plainLines(toolName: string, input: Record<string, unknown>): string[] | undefined {
  const result = formatToolDiff(toolName, input);
  return result === undefined ? undefined : stripVTControlCharacters(result).split("\n");
}

describe("formatToolDiff", () => {
  it("Edit 한 줄 변경은 삭제·추가 줄을 보인다", () => {
    const lines = plainLines("Edit", { old_string: "old", new_string: "new" });
    expect(lines).toContain("    - old");
    expect(lines).toContain("    + new");
  });

  it("바뀌지 않은 줄은 변경 앞뒤 2줄만 남긴다", () => {
    const before = ["a1", "a2", "a3", "a4", "a5"];
    const after = ["b1", "b2", "b3", "b4", "b5"];
    const lines = plainLines("Edit", {
      old_string: [...before, "old", ...after].join("\n"),
      new_string: [...before, "new", ...after].join("\n"),
    });
    expect(lines).toContain("    - old");
    expect(lines).toContain("    + new");
    expect(lines).toContain("      a4");
    expect(lines).toContain("      a5");
    expect(lines).toContain("      b1");
    expect(lines).toContain("      b2");
    expect(lines).not.toContain("      a3");
    expect(lines).not.toContain("      b3");
  });

  it.each([1, 2, 3])("변경 앞의 문맥이 %i줄이면 직전 2줄까지 남긴다", (count) => {
    const context = ["x1", "x2", "x3"].slice(3 - count);
    const lines = plainLines("Edit", {
      old_string: [...context, "old"].join("\n"),
      new_string: [...context, "new"].join("\n"),
    });
    expect(lines).toEqual([...context.slice(-2).map((line) => `      ${line}`), "    - old", "    + new"]);
  });

  it("앞뒤 변경 사이의 짧은 문맥은 중복 없이 모두 남긴다", () => {
    const lines = plainLines("Edit", {
      old_string: "old1\nm1\nm2\nm3\nold2",
      new_string: "new1\nm1\nm2\nm3\nnew2",
    });
    expect(lines?.filter((line) => line.endsWith("m1"))).toHaveLength(1);
    expect(lines?.filter((line) => line.endsWith("m3"))).toHaveLength(1);
  });

  it("replace_all이면 첫 줄에 표시한다", () => {
    const lines = plainLines("Edit", { old_string: "x", new_string: "y", replace_all: true });
    expect(lines?.[0]).toBe("    (모든 위치 바꿈)");
  });

  it("Write는 content 전체를 추가 줄로 보인다", () => {
    expect(plainLines("Write", { content: "a\nb\nc" })).toEqual(["    + a", "    + b", "    + c"]);
  });

  it("Write 끝의 줄바꿈은 빈 추가 줄을 만들지 않는다", () => {
    expect(plainLines("Write", { content: "a\nb\nc\n" })).toEqual(["    + a", "    + b", "    + c"]);
  });

  it("DIFF_MAX_LINES를 넘으면 잘라내고 남은 줄 수를 보인다", () => {
    const content = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    const lines = plainLines("Write", { content });
    expect(DIFF_MAX_LINES).toBe(40);
    expect(lines).toHaveLength(41);
    expect(lines?.[40]).toBe("    … 60줄 더");
  });

  it("다른 도구는 undefined", () => {
    expect(formatToolDiff("Read", { file_path: "/a" })).toBeUndefined();
  });

  it("필요한 문자열 필드가 없으면 undefined", () => {
    expect(formatToolDiff("Edit", { old_string: "a" })).toBeUndefined();
    expect(formatToolDiff("Write", {})).toBeUndefined();
  });
});
