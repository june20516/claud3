import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { initialMood, readMood } from "../src/persona/mood.js";
import type { MoodReason, MoodState } from "../src/persona/mood.js";
import type { PersonaProfile } from "../src/persona/profile.js";
import type { Experience } from "../src/persona/memory/experience.js";
import { buildSystemAppend, buildTurnContext, formatMemoryDate } from "../src/persona/prompt.js";
import type { TurnReport } from "../src/persona/prompt.js";

const PROFILE = JSON.parse(
  readFileSync(new URL("./fixtures/persona-rapi.json", import.meta.url), "utf8"),
) as PersonaProfile;
// 2026-11-05는 목요일
const THURSDAY_NIGHT = new Date(2026, 10, 5, 21, 40);

function reason(text: string): MoodReason {
  return { at: THURSDAY_NIGHT.toISOString(), text, stress: 1, dopamine: 0 };
}

function report(overrides: Partial<MoodState>, extra: Partial<TurnReport> = {}): TurnReport {
  const state = { ...initialMood(THURSDAY_NIGHT), ...overrides };
  return {
    state,
    reading: readMood(state.stress, state.dopamine),
    reasons: [],
    flips: [],
    actions: [],
    recalled: [],
    now: THURSDAY_NIGHT,
    ...extra,
  };
}

describe("buildSystemAppend", () => {
  const append = buildSystemAppend(PROFILE);

  it("인격 소개를 담는다", () => {
    for (const text of ["라피", PROFILE.summary, "후배", "존댓말", "…그러니까요.", "욕설", "선배, 이거 또 깨졌는데요."]) {
      expect(append).toContain(text);
    }
  });

  it("네 방향과 평온의 성향을 담는다", () => {
    for (const text of ["담담하게 일한다", "키보드를 내려치며", "거의 말하지 않는다", "수다를 쏟아낸다", "책상에 엎드려"]) {
      expect(append).toContain(text);
    }
  });

  it("상태 블록 설명과 출력 규칙을 담는다", () => {
    expect(append).toContain("[라피 상태]");
    expect(append).toContain("따로 한 줄에 `(...)`");
    expect(append).toContain("코드·명령·파일 내용·도구 입력에는 인격을 섞지 않는다");
  });

  it("반말 인격은 반말로 안내한다", () => {
    expect(buildSystemAppend({ ...PROFILE, speechLevel: "casual" })).toContain("반말");
  });
});

describe("buildTurnContext", () => {
  it("극단 상태는 방향·세기·턴 수·수치를 첫 줄에 쓴다", () => {
    const text = buildTurnContext(PROFILE, report({ stress: 88.2, dopamine: -61.4, extremeTurns: 3 }));
    expect(text.split("\n")[0]).toBe("[라피 상태] 방향: cold(차가운 붕괴), 세기: 극단 3턴째. stress +88, dopamine −61.");
  });

  it("극단이 아니면 턴 수 없이 세기만", () => {
    const text = buildTurnContext(PROFILE, report({ stress: -40, dopamine: 70 }));
    expect(text.split("\n")[0]).toBe("[라피 상태] 방향: elated(들뜸), 세기: 강함. stress −40, dopamine +70.");
  });

  it("평온이면 방향 대신 평온", () => {
    const text = buildTurnContext(PROFILE, report({ stress: 12, dopamine: 0 }));
    expect(text.split("\n")[0]).toBe("[라피 상태] 방향: 평온. stress +12, dopamine 0.");
  });

  it("같은 원인은 횟수로 합친다", () => {
    const reasons = ["퇴근 시간 이후", "도구 실패", "도구 실패", "도구 실패"].map(reason);
    expect(buildTurnContext(PROFILE, report({}, { reasons }))).toContain("최근 원인: 퇴근 시간 이후, 도구 실패 3회.");
  });

  it("최근 원인은 마지막 3개만", () => {
    const reasons = ["a", "b", "c", "d"].map(reason);
    expect(buildTurnContext(PROFILE, report({}, { reasons }))).toContain("최근 원인: b, c, d.");
  });

  it("시각과 요일을 쓴다", () => {
    expect(buildTurnContext(PROFILE, report({}))).toContain("시각: 21:40, 목요일.");
  });

  it("부호 전환을 알린다", () => {
    const text = buildTurnContext(PROFILE, report({}, { flips: [{ axis: "dopamine", to: "negative" }, { axis: "stress", to: "positive" }] }));
    expect(text).toContain("방금 dopamine이 음수로 바뀜.");
    expect(text).toContain("방금 stress가 양수로 바뀜.");
  });

  it("사용자 행동과 그 효과를 쓴다", () => {
    const actions = [{ action: "츄르를 준다", stress: -20, dopamine: 25 }];
    expect(buildTurnContext(PROFILE, report({}, { actions }))).toContain("사용자 행동: 츄르를 준다 → stress −20, dopamine +25.");
  });
});

const NOV_19 = new Date(2026, 10, 19, 15, 41).toISOString();

function memory(overrides: Partial<Experience> = {}): Experience {
  return {
    id: "e1",
    summary: "main이 바뀌어 있었다",
    feeling: "…다행이었어요.",
    importance: 2,
    at: NOV_19,
    sessionId: "s1",
    moodReasons: [],
    moodDelta: { stress: 0, dopamine: 3 },
    ...overrides,
  };
}

describe("기억", () => {
  it("formatMemoryDate는 로컬 시각 M/D", () => {
    expect(formatMemoryDate(NOV_19)).toBe("11/19");
    expect(formatMemoryDate(new Date(2026, 0, 5, 9, 0).toISOString())).toBe("1/5");
  });

  it("기억이 없으면 append가 그대로", () => {
    expect(buildSystemAppend(PROFILE, { memories: [] })).toBe(buildSystemAppend(PROFILE));
  });

  it("기억 단락과 항목", () => {
    const append = buildSystemAppend(PROFILE, { memories: [memory(), memory({ id: "e2", summary: "칭찬을 들었다", feeling: "별거 아니에요." })] });
    expect(append).toContain(
      [
        "## 기억",
        "사용자와 함께한 일 중 기억나는 것. 대화에 자연스러울 때만 꺼내고, 억지로 언급하지 않는다.",
        "- 11/19 main이 바뀌어 있었다 (…다행이었어요.)",
        "- 11/19 칭찬을 들었다 (별거 아니에요.)",
      ].join("\n"),
    );
  });

  it("소감이 비면 괄호를 붙이지 않는다", () => {
    const append = buildSystemAppend(PROFILE, { memories: [memory({ feeling: "" })] });
    expect(append).toContain("- 11/19 main이 바뀌어 있었다\n");
    expect(append).not.toContain("()");
  });

  it("lead가 있으면 먼저 언급 줄", () => {
    const lead = memory({ importance: 3 });
    expect(buildSystemAppend(PROFILE, { memories: [lead], lead })).toContain(
      "- 첫 대화에서 이 일을 먼저 언급해도 된다(한 번만): 11/19 main이 바뀌어 있었다",
    );
  });

  it("회상이 없으면 줄이 없다", () => {
    expect(buildTurnContext(PROFILE, report({}))).not.toContain("떠오른 기억");
  });

  it("회상 줄과 강하게 떠오름", () => {
    const weak = buildTurnContext(PROFILE, report({}, { recalled: [{ experience: memory(), strong: false }] }));
    expect(weak).toContain("떠오른 기억: 11/19 main이 바뀌어 있었다");
    expect(weak).not.toContain("강하게 떠오름");
    const strong = buildTurnContext(PROFILE, report({}, { recalled: [{ experience: memory({ importance: 3 }), strong: true }] }));
    expect(strong).toContain("떠오른 기억: 11/19 main이 바뀌어 있었다\n강하게 떠오름 — 하던 얘기를 멈추고 먼저 꺼내도 된다.");
  });
});
