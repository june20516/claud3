import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRecordPrompt, parseRecordOutput, RECORD_SCHEMA } from "../src/persona/memory/recordPrompt.js";
import type { RecordPromptInput } from "../src/persona/memory/recordPrompt.js";
import type { PersonaProfile } from "../src/persona/profile.js";

const PROFILE = JSON.parse(
  readFileSync(new URL("./fixtures/persona-rapi.json", import.meta.url), "utf8"),
) as PersonaProfile;

function input(overrides: Partial<RecordPromptInput> = {}): RecordPromptInput {
  return {
    profile: PROFILE,
    segment: { lines: ["사용자: 고마워, 잘했어", "⏺ Bash (성공)"], context: [], lastUuid: "m9", userInputs: 1 },
    mood: { moodReasons: ["칭찬"], moodDelta: { stress: -4, dopamine: 8 }, strongHints: [] },
    recentSummaries: [],
    ...overrides,
  };
}

const item = (summary: string, importance: unknown = 2) => ({ summary, feeling: "음.", importance });

describe("buildRecordPrompt", () => {
  it("인격, 구간, 기분 이유, 기준을 담는다", () => {
    const prompt = buildRecordPrompt(input());
    expect(prompt).toContain(PROFILE.displayName);
    expect(prompt).toContain(PROFILE.summary);
    expect(prompt).toContain("사용자: 고마워, 잘했어");
    expect(prompt).toContain("⏺ Bash (성공)");
    expect(prompt).toContain("칭찬");
    expect(prompt).toContain("기본값은 0개");
  });

  it("맥락은 있을 때만 참고용으로", () => {
    expect(buildRecordPrompt(input())).not.toContain("참고용");
    const withContext = buildRecordPrompt(input({ segment: { ...input().segment, context: ["사용자: 이전 얘기"] } }));
    expect(withContext).toContain("참고용");
    expect(withContext).toContain("사용자: 이전 얘기");
  });

  it("최근 요약은 있을 때만", () => {
    expect(buildRecordPrompt(input())).not.toContain("이미 기억하는 일");
    const withRecent = buildRecordPrompt(input({ recentSummaries: ["main이 바뀌어 있었다"] }));
    expect(withRecent).toContain("이미 기억하는 일");
    expect(withRecent).toContain("main이 바뀌어 있었다");
  });

  it("표시점이 있으면 강한 후보", () => {
    expect(buildRecordPrompt(input())).not.toContain("강한 후보");
    const strong = buildRecordPrompt(input({ mood: { ...input().mood, strongHints: ["극단 진입: 뜨거운 과열"] } }));
    expect(strong).toContain("강한 후보");
    expect(strong).toContain("극단 진입: 뜨거운 과열");
  });
});

describe("parseRecordOutput", () => {
  it("빈 배열은 정상 결과", () => {
    expect(parseRecordOutput({ experiences: [] })).toEqual([]);
  });

  it("유효한 항목만 앞에서 3개", () => {
    const output = { experiences: [item("하나"), item("깨짐", 2.5), item("둘", 1), item("셋", 3), item("넷")] };
    expect(parseRecordOutput(output)?.map((entry) => entry.summary)).toEqual(["하나", "둘", "셋"]);
  });

  it("중요도가 정수 1~3이 아니거나 summary가 비면 버린다", () => {
    const output = { experiences: [item("영", 0), item("문자", "3"), item("  "), item("정상", 1)] };
    expect(parseRecordOutput(output)?.map((entry) => entry.summary)).toEqual(["정상"]);
  });

  it("긴 글은 자른다", () => {
    const [entry] = parseRecordOutput({ experiences: [{ summary: "가".repeat(150), feeling: "나".repeat(80), importance: 2 }] }) ?? [];
    expect(entry?.summary).toHaveLength(120);
    expect(entry?.feeling).toHaveLength(60);
  });

  it("형식이 아예 틀리면 undefined", () => {
    expect(parseRecordOutput(null)).toBeUndefined();
    expect(parseRecordOutput({})).toBeUndefined();
    expect(parseRecordOutput({ experiences: "x" })).toBeUndefined();
  });

  it("schema는 최대 3개", () => {
    expect(JSON.stringify(RECORD_SCHEMA)).toContain('"maxItems":3');
  });
});
