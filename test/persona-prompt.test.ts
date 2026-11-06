import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { initialMood, readMood } from "../src/persona/mood.js";
import type { MoodReason, MoodState } from "../src/persona/mood.js";
import type { PersonaProfile } from "../src/persona/profile.js";
import { buildSystemAppend, buildTurnContext } from "../src/persona/prompt.js";
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
