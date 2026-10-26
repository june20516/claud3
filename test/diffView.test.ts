import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIFF_MAX_LINES, formatDiffSummary, formatToolDiff } from "../src/diffView.js";

// 파스텔 배경(256색 연두 194·분홍 224)에 진한 글자(초록 22·빨강 88).
const ADDED_STYLE = "\u001b[48;5;194m\u001b[38;5;22m";
const REMOVED_STYLE = "\u001b[48;5;224m\u001b[38;5;88m";
const RESET_STYLE = "\u001b[49m\u001b[39m";

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

  it("추가 줄은 연두 배경에 진한 초록, 삭제 줄은 분홍 배경에 진한 빨강 글자이고 문맥 줄에는 색이 없다", () => {
    forceColor();
    const [context, removed, added] = rawLines({ old_string: "same\nold", new_string: "same\nnew" });

    expect(removed).toContain(REMOVED_STYLE);
    expect(added).toContain(ADDED_STYLE);
    for (const line of [removed, added]) {
      expect(line?.endsWith(RESET_STYLE)).toBe(true);
    }
    expect(context).not.toContain("\u001b[48;5;");
  });

  it("배경은 들여쓰기를 포함해 줄 맨 앞부터 깐다", () => {
    forceColor();
    const [removed, added] = rawLines({ old_string: "old", new_string: "new" }, { width: 20 });

    expect(removed?.startsWith(`${REMOVED_STYLE}    - old`)).toBe(true);
    expect(added?.startsWith(`${ADDED_STYLE}    + new`)).toBe(true);
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

describe("formatDiffSummary", () => {
  const cwd = "/work";
  const fileWith = (content: string) => (path: string) => (path === "/work/src/a.ts" ? content : undefined);
  const summary = (toolName: string, input: Record<string, unknown>, readFile: (path: string) => string | undefined) =>
    stripVTControlCharacters(formatDiffSummary(toolName, input, { cwd, readFile }) ?? "");

  const lines = (count: number): string => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

  it("파일에서 바꿀 문자열의 위치로 행 번호를 찾아 삭제·추가 줄 수를 요약한다", () => {
    const content = `${lines(11)}\na\nb\ntail`;
    const input = { file_path: "/work/src/a.ts", old_string: "a\nb", new_string: "a\nc\nd" };

    expect(summary("Edit", input, fileWith(content))).toBe("⎿ src/a.ts · 13행 1줄 삭제, 13행 2줄 추가");
  });

  it("이미 수정이 적용됐으면 새 문자열의 위치로 찾는다", () => {
    const content = `${lines(11)}\na\nc\nd\ntail`;
    const input = { file_path: "/work/src/a.ts", old_string: "a\nb", new_string: "a\nc\nd" };

    expect(summary("Edit", input, fileWith(content))).toBe("⎿ src/a.ts · 13행 1줄 삭제, 13행 2줄 추가");
  });

  it("위치를 찾지 못하면 줄 수만 보인다", () => {
    const input = { file_path: "/work/src/a.ts", old_string: "x", new_string: "y\nz" };

    expect(summary("Edit", input, () => undefined)).toBe("⎿ src/a.ts · 1줄 삭제, 2줄 추가");
  });

  it("떨어진 변경은 각각의 행을 보이고, 추가만 있으면 추가만 보인다", () => {
    const input = { file_path: "/work/src/a.ts", old_string: "a\nb\nc\nd\ne\nf\ng\n", new_string: "a\nB\nc\nd\ne\nf\ng\nh\n" };

    expect(summary("Edit", input, fileWith("a\nb\nc\nd\ne\nf\ng\n"))).toBe(
      "⎿ src/a.ts · 2행 1줄 삭제, 2행 1줄 추가, 8행 1줄 추가",
    );
  });

  it("replace_all은 위치 없이 모든 위치 바꿈으로 보인다", () => {
    const input = { file_path: "/work/src/a.ts", old_string: "x", new_string: "y", replace_all: true };

    expect(summary("Edit", input, fileWith("x\nx"))).toBe("⎿ src/a.ts · 모든 위치 바꿈: 1줄 삭제, 1줄 추가");
  });

  it("Write는 새 파일이면 새 파일 줄 수, 있던 파일이면 덮어쓴 줄 수를 보인다", () => {
    const write = { file_path: "/work/src/a.ts", content: "a\nb\nc\n" };

    expect(summary("Write", write, () => undefined)).toBe("⎿ src/a.ts · 새 파일 3줄");
    expect(summary("Write", write, fileWith("old"))).toBe("⎿ src/a.ts · 파일 전체 3줄로 바꿈");
  });

  it("cwd 밖 경로는 그대로 보이고, 다른 도구나 경로가 없으면 undefined", () => {
    const input = { file_path: "/etc/hosts", old_string: "a", new_string: "b" };

    expect(summary("Edit", input, () => undefined)).toBe("⎿ /etc/hosts · 1줄 삭제, 1줄 추가");
    expect(formatDiffSummary("Bash", { command: "ls" }, { cwd, readFile: () => undefined })).toBeUndefined();
    expect(formatDiffSummary("Edit", { old_string: "a", new_string: "b" }, { cwd, readFile: () => undefined })).toBeUndefined();
  });
});
