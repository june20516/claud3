import { stripVTControlCharacters } from "node:util";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { afterAll, describe, expect, it, vi } from "vitest";
import { StatusBar } from "../src/ui/ink/StatusBar.js";

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

describe("StatusBar 배경", () => {
  it("배경 띠가 터미널 폭 전체를 차지하고, 글자는 흐리게 하지 않는다", () => {
    const { lastFrame, stdout } = render(<StatusBar model="claude-test" sessionCostUsd={0} />);
    const frame = lastFrame() ?? "";

    expect(frame).toContain(BACKGROUND);
    expect(frame).not.toContain(DIM);
    expect(stringWidth(stripVTControlCharacters(frame))).toBe(stdout.columns);
  });
});
