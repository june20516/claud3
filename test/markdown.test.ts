import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMarkdownRenderer, renderMarkdownLine } from "../src/markdown.js";

const plain = (line: string, inCodeBlock = false): string =>
  stripVTControlCharacters(renderMarkdownLine(line, { inCodeBlock }));

const BOLD = "\u001b[1m";
const CYAN = "\u001b[36m";

// 비TTY 테스트 환경에서도 ANSI 코드가 나오도록 색을 강제한다.
beforeEach(() => {
  vi.stubEnv("FORCE_COLOR", "1");
  vi.stubEnv("NO_COLOR", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("renderMarkdownLine", () => {
  it("제목에서 # 기호를 빼고 굵게 표시한다", () => {
    expect(plain("# 제목")).toBe("제목");
    expect(plain("### 소제목")).toBe("소제목");
    expect(renderMarkdownLine("## 제목", { inCodeBlock: false })).toContain(BOLD);
  });

  it("목록 기호를 •로 바꾸고 들여쓰기를 유지한다", () => {
    expect(plain("- 하나")).toBe("• 하나");
    expect(plain("  * 둘")).toBe("  • 둘");
    expect(plain("+ 셋")).toBe("• 셋");
  });

  it("**굵게**로 시작하는 줄은 목록이 아니다", () => {
    expect(plain("**굵게** 시작")).toBe("굵게 시작");
  });

  it("인용을 │ 로 바꾼다", () => {
    expect(plain("> 인용문")).toBe("│ 인용문");
  });

  it("굵게를 적용하고 기호를 제거한다", () => {
    expect(plain("a **b** c")).toBe("a b c");
    expect(renderMarkdownLine("a **b** c", { inCodeBlock: false })).toContain(BOLD);
  });

  it("인라인 코드를 청록으로 칠하고 기호를 제거한다", () => {
    expect(plain("run `npm test` now")).toBe("run npm test now");
    expect(renderMarkdownLine("`x`", { inCodeBlock: false })).toContain(CYAN);
  });

  it("인라인 코드 안의 **는 굵게로 바꾸지 않는다", () => {
    expect(plain("`a **b** c`")).toBe("a **b** c");
  });

  it("링크를 텍스트와 흐린 URL로 바꾼다", () => {
    expect(plain("[문서](https://example.com)")).toBe("문서 (https://example.com)");
  });

  it("코드 블록을 토글하고 안에서는 다른 규칙을 적용하지 않는다", () => {
    const state = { inCodeBlock: false };
    expect(stripVTControlCharacters(renderMarkdownLine("```ts", state))).toBe("```ts");
    expect(state.inCodeBlock).toBe(true);
    const inside = renderMarkdownLine("**x** # y", state);
    expect(stripVTControlCharacters(inside)).toBe("**x** # y");
    expect(inside).toContain(CYAN);
    renderMarkdownLine("```", state);
    expect(state.inCodeBlock).toBe(false);
  });

  it("표와 번호 목록은 그대로 둔다", () => {
    expect(plain("| a | b |")).toBe("| a | b |");
    expect(plain("1. 첫째")).toBe("1. 첫째");
  });

  it("한국어 텍스트를 보존한다", () => {
    expect(plain("안녕하세요, 세계")).toBe("안녕하세요, 세계");
  });
});

describe("createMarkdownRenderer", () => {
  it("완성된 줄만 돌려주고 나머지는 보관한다", () => {
    const renderer = createMarkdownRenderer();
    expect(renderer.push("# He")).toBe("");
    expect(stripVTControlCharacters(renderer.push("llo\nnext"))).toBe("Hello\n");
    expect(stripVTControlCharacters(renderer.flush())).toBe("next");
    expect(renderer.flush()).toBe("");
  });

  it("닫히지 않은 코드 블록도 flush 뒤에는 코드 블록 상태가 아니다", () => {
    const renderer = createMarkdownRenderer();
    renderer.push("```\ncode\n");
    renderer.flush();
    expect(stripVTControlCharacters(renderer.push("**b**\n"))).toBe("b\n");
  });
});
