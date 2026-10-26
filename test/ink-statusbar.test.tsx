import { stripVTControlCharacters } from "node:util";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { afterAll, describe, expect, it, vi } from "vitest";
import { StatusBar } from "../src/ui/ink/StatusBar.js";
import { Transcript } from "../src/ui/ink/TranscriptView.js";
import { initialTranscript, reduceTranscript } from "../src/ui/ink/transcript.js";

// Ink(chalk)는 모듈을 불러올 때 색 지원 여부를 정하므로, 이 파일의 import보다 먼저 색을 켠다.
const { originalForceColor } = vi.hoisted(() => {
  const original = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "3";
  return { originalForceColor: original };
});

// 같은 worker의 다른 테스트 파일에 영향을 주지 않도록 되돌린다.
afterAll(() => {
  if (originalForceColor === undefined) {
    delete process.env.FORCE_COLOR;
  } else {
    process.env.FORCE_COLOR = originalForceColor;
  }
});

const BACKGROUND = "\u001b[48;";
const DIM = "\u001b[2m";
// 밝은 회색 글자(#d0d0d0). 터미널 기본 글자색에 맡기면 밝은 테마에서 배경과 구분되지 않는다.
const LIGHT_FOREGROUND = "\u001b[38;2;208;208;208m";

describe("StatusBar 배경", () => {
  it("배경 띠가 터미널 폭 전체를 차지하고, 글자는 흐리게 하지 않는다", () => {
    const { lastFrame, stdout } = render(<StatusBar model="claude-test" sessionCostUsd={0} />);
    const frame = lastFrame() ?? "";

    expect(frame).toContain(BACKGROUND);
    expect(frame).not.toContain(DIM);
    expect(stringWidth(stripVTControlCharacters(frame))).toBe(stdout.columns);
  });

  it("글자색을 밝은 회색으로 명시해 터미널 테마와 관계없이 배경과 대비된다", () => {
    const { lastFrame } = render(<StatusBar model="claude-test" sessionCostUsd={0} />);

    expect(lastFrame() ?? "").toContain(LIGHT_FOREGROUND);
  });
});

describe("StatusBar 위치 정보", () => {
  const DIRECTORY_COLOR = "\u001b[38;2;135;175;215m";
  const BRANCH_COLOR = "\u001b[38;2;175;215;135m";

  it("디렉터리와 브랜치를 각각 다른 색으로 왼쪽에, 기존 정보를 오른쪽에 보인다", () => {
    const { lastFrame, stdout } = render(
      <StatusBar model="claude-test" sessionCostUsd={0} workspace={{ directory: "~/repo", branch: "main" }} />,
    );
    const frame = lastFrame() ?? "";
    const text = stripVTControlCharacters(frame);

    expect(frame).toContain(`${DIRECTORY_COLOR} ~/repo`);
    expect(frame).toContain(BRANCH_COLOR);
    expect(text.startsWith(" ~/repo  main")).toBe(true);
    expect(text.trimEnd().endsWith("claude-test · 세션 $0.0000")).toBe(true);
    expect(stringWidth(text)).toBe(stdout.columns);
  });

  it("폭이 모자라면 디렉터리 앞부분을 잘라 오른쪽 정보는 끝까지 남긴다", () => {
    const directory = `~/${"very-long-directory/".repeat(8)}leaf`;
    const { lastFrame, stdout } = render(
      <StatusBar model="claude-test" sessionCostUsd={0} workspace={{ directory, branch: "main" }} />,
    );
    const text = stripVTControlCharacters(lastFrame() ?? "");

    expect(text.split("\n")).toHaveLength(1);
    expect(stringWidth(text)).toBe(stdout.columns);
    expect(text).toContain("…");
    expect(text).toContain("leaf");
    expect(text.trimEnd().endsWith("claude-test · 세션 $0.0000")).toBe(true);
  });

  it("오른쪽 정보만으로 폭이 거의 차면 위치를 빼고 한 줄로 자른다", () => {
    const model = `claude-${"x".repeat(95)}`;
    const { lastFrame, stdout } = render(
      <StatusBar model={model} sessionCostUsd={0} workspace={{ directory: "~/repo", branch: "main" }} />,
    );
    const text = stripVTControlCharacters(lastFrame() ?? "");

    expect(text.split("\n")).toHaveLength(1);
    expect(stringWidth(text)).toBe(stdout.columns);
    expect(text).not.toContain("~/repo");
    expect(text.startsWith(" claude-xxx")).toBe(true);
  });

  it("위치를 모르면 기존 정보만 왼쪽에 보인다", () => {
    const text = stripVTControlCharacters(render(<StatusBar model="claude-test" sessionCostUsd={0} />).lastFrame() ?? "");

    expect(text.startsWith(" claude-test · 세션 $0.0000")).toBe(true);
  });
});

describe("도구 줄", () => {
  it("도구 사용 줄과 diff 요약은 메시지보다 흐리게(dim) 보인다", () => {
    const state = reduceTranscript(initialTranscript, {
      type: "tool_start",
      toolUseId: "t1",
      name: "Edit",
      summary: "a.ts",
      input: { file_path: "a.ts", old_string: "old", new_string: "new" },
    });

    const frame = render(<Transcript state={{ ...state, running: [] }} />).lastFrame() ?? "";

    expect(frame).toContain(`${DIM}⏺ Edit(a.ts)`);
    expect(frame).toContain(`${DIM}  ⎿ a.ts`);
  });
});
