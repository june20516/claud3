import { describe, expect, it } from "vitest";
import { sliceChars } from "../src/persona/text.js";

describe("sliceChars", () => {
  it("코드 포인트 단위로 앞에서 자른다", () => {
    expect(sliceChars("가나다라", 2)).toBe("가나");
  });

  it("이모지를 반으로 자르지 않는다", () => {
    expect(sliceChars("ab😀cd", 3)).toBe("ab😀");
  });

  it("짧으면 그대로", () => {
    expect(sliceChars("짧음", 10)).toBe("짧음");
  });
});
