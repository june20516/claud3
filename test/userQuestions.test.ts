import { describe, expect, it } from "vitest";
import type { UserQuestion } from "../src/types.js";
import {
  formatAnswerSummary,
  formatQuestionPrompt,
  parseQuestionAnswer,
  parseUserQuestions,
} from "../src/userQuestions.js";

const single: UserQuestion = {
  question: "어떤 방식으로 할까요?",
  header: "방식",
  multiSelect: false,
  options: [
    { label: "A안", description: "빠름" },
    { label: "B안", description: "안전함" },
  ],
};

const multi: UserQuestion = {
  question: "어떤 기능을 켤까요?",
  header: "기능",
  multiSelect: true,
  options: [
    { label: "로그", description: "기록" },
    { label: "알림", description: "통지" },
    { label: "통계", description: "집계" },
  ],
};

describe("parseUserQuestions", () => {
  it("SDK 입력에서 질문 목록을 읽는다 (preview 등 다른 필드는 버린다)", () => {
    const input = {
      questions: [
        {
          ...single,
          options: [
            { label: "A안", description: "빠름", preview: "미리보기" },
            { label: "B안", description: "안전함" },
          ],
        },
      ],
    };

    expect(parseUserQuestions(input)).toEqual([single]);
  });

  it("multiSelect가 없으면 단일 선택으로 본다", () => {
    const { multiSelect: _omitted, ...withoutMulti } = single;
    expect(parseUserQuestions({ questions: [withoutMulti] })?.[0]?.multiSelect).toBe(false);
  });

  it("형식이 맞지 않으면 undefined", () => {
    expect(parseUserQuestions({})).toBeUndefined();
    expect(parseUserQuestions({ questions: [] })).toBeUndefined();
    expect(parseUserQuestions({ questions: [{ question: "q", header: "h", options: "x" }] })).toBeUndefined();
    expect(parseUserQuestions({ questions: [{ question: "q", header: "h", options: [{ label: 1 }] }] })).toBeUndefined();
  });
});

describe("parseQuestionAnswer", () => {
  it("번호는 선택지 label로 바꾼다", () => {
    expect(parseQuestionAnswer("2", single)).toBe("B안");
    expect(parseQuestionAnswer(" 1 ", single)).toBe("A안");
  });

  it("복수 선택은 쉼표로 여러 번호를 받아 label을 ', '로 잇는다", () => {
    expect(parseQuestionAnswer("3, 1", multi)).toBe("통계, 로그");
  });

  it("단일 선택에 번호 여러 개나 범위 밖 번호는 직접 입력한 답으로 본다", () => {
    expect(parseQuestionAnswer("1,2", single)).toBe("1,2");
    expect(parseQuestionAnswer("9", single)).toBe("9");
  });

  it("번호가 아니면 입력한 그대로 답으로 쓴다", () => {
    expect(parseQuestionAnswer("둘 다 아니고 C안", single)).toBe("둘 다 아니고 C안");
  });

  it("빈 답은 undefined", () => {
    expect(parseQuestionAnswer("   ", single)).toBeUndefined();
  });
});

describe("formatQuestionPrompt", () => {
  it("순서, header, 질문, 번호 붙은 선택지와 입력 안내를 보인다", () => {
    expect(formatQuestionPrompt(multi, 1, 2)).toBe(
      [
        "[2/2 기능] 어떤 기능을 켤까요?",
        "  1. 로그 — 기록",
        "  2. 알림 — 통지",
        "  3. 통계 — 집계",
        "번호(여러 개는 쉼표로)나 직접 쓴 답을 입력하세요",
      ].join("\n"),
    );
  });

  it("질문이 하나면 순서를 빼고, 단일 선택 안내를 보인다", () => {
    expect(formatQuestionPrompt(single, 0, 1).split("\n")).toEqual([
      "[방식] 어떤 방식으로 할까요?",
      "  1. A안 — 빠름",
      "  2. B안 — 안전함",
      "번호나 직접 쓴 답을 입력하세요",
    ]);
  });
});

describe("formatAnswerSummary", () => {
  it("질문마다 header와 답을 한 줄로 보인다", () => {
    expect(formatAnswerSummary([single, multi], { [single.question]: "A안", [multi.question]: "로그, 통계" })).toBe(
      "방식: A안\n기능: 로그, 통계",
    );
  });
});
