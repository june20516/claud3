import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  advanceExtremeTurns,
  applyEvent,
  decay,
  initialMood,
  isWorkTime,
  parseMoodState,
  readMood,
  rememberPrompt,
  signFlips,
} from "../src/persona/mood.js";
import type { MoodEvent, MoodState } from "../src/persona/mood.js";
import type { PersonaProfile } from "../src/persona/profile.js";

const PROFILE = JSON.parse(
  readFileSync(new URL("./fixtures/persona-rapi.json", import.meta.url), "utf8"),
) as PersonaProfile;

// 2026-11-02 월, 11-04 수, 11-06 금, 11-07 토 (로컬 시각)
const WEDNESDAY = new Date(2026, 10, 4, 10, 0);
const MONDAY = new Date(2026, 10, 2, 10, 0);
const FRIDAY = new Date(2026, 10, 6, 10, 0);
const SATURDAY = new Date(2026, 10, 7, 10, 0);
const OFFICE = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };

function mood(overrides: Partial<MoodState> = {}): MoodState {
  return { ...initialMood(WEDNESDAY), ...overrides };
}

function profileWith(overrides: Partial<PersonaProfile>): PersonaProfile {
  return { ...PROFILE, ...overrides };
}

function apply(state: MoodState, events: MoodEvent[], profile = PROFILE, now = WEDNESDAY): MoodState {
  return events.reduce((current, event) => applyEvent(current, event, profile, now), state);
}

describe("applyEvent", () => {
  it("도구 실패는 stress +4, 커플링으로 dopamine −1.2", () => {
    const next = apply(mood(), [{ kind: "toolFailure" }]);
    expect(next.stress).toBeCloseTo(4);
    expect(next.dopamine).toBeCloseTo(-1.2);
    expect(next.failureStreak).toBe(1);
  });

  it("연속 실패는 회당 +2씩 늘고 이벤트당 최대 +10", () => {
    const increments: number[] = [];
    let state = mood();
    for (let index = 0; index < 6; index++) {
      const next = apply(state, [{ kind: "toolFailure" }]);
      increments.push(Math.round(next.stress - state.stress));
      state = next;
    }
    expect(increments).toEqual([4, 6, 8, 10, 10, 10]);
  });

  it("도구 성공은 연속 실패를 끊는다", () => {
    const next = apply(mood({ failureStreak: 3 }), [{ kind: "toolSuccess" }]);
    expect(next.failureStreak).toBe(0);
    expect(next.stress).toBeCloseTo(-1);
  });

  it("테스트 통과는 stress −3, dopamine +6 + 커플링 0.9", () => {
    const next = apply(mood(), [{ kind: "testPassed" }]);
    expect(next.stress).toBeCloseTo(-3);
    expect(next.dopamine).toBeCloseTo(6.9);
    expect(next.failureStreak).toBe(0);
  });

  it("민감도 배율을 stress와 dopamine에 각각 곱한다", () => {
    const sensitive = profileWith({ sensitivity: { stress: 5, dopamine: 1 } });
    expect(apply(mood(), [{ kind: "toolFailure" }], sensitive).stress).toBeCloseTo(8);
    // praise: stress −4×2 = −8 → 커플링 +2.4, dopamine 고유분 8×0.5 = 4
    expect(apply(mood(), [{ kind: "praise" }], sensitive).dopamine).toBeCloseTo(6.4);
  });

  it("요일 배율은 stress 증가분에만 곱한다 (월 ×1.2, 금 ×0.8)", () => {
    expect(apply(mood(), [{ kind: "toolFailure" }], PROFILE, MONDAY).stress).toBeCloseTo(4.8);
    expect(apply(mood(), [{ kind: "toolFailure" }], PROFILE, FRIDAY).stress).toBeCloseTo(3.2);
    expect(apply(mood(), [{ kind: "toolSuccess" }], PROFILE, MONDAY).stress).toBeCloseTo(-1);
  });

  it("사용자 행동 반응에는 민감도·요일 배율을 곱하지 않고 커플링만 적용한다", () => {
    const sensitive = profileWith({ sensitivity: { stress: 5, dopamine: 5 } });
    const event: MoodEvent = { kind: "userAction", action: "츄르를 준다", stress: -20, dopamine: 25 };
    const next = apply(mood(), [event], sensitive, MONDAY);
    expect(next.stress).toBeCloseTo(-20);
    expect(next.dopamine).toBeCloseTo(31);
    expect(next.recentReasons.at(-1)?.text).toBe("츄르를 준다");
  });

  it("수치는 −100~100으로 자른다", () => {
    expect(apply(mood({ stress: 99 }), [{ kind: "insult" }]).stress).toBe(100);
  });

  it("업무 시간에는 절댓값 상한 84, 업무 시간 밖에는 상한 없음", () => {
    const office = profileWith({ workHours: OFFICE });
    const monday = new Date(2026, 10, 2, 10, 0);
    expect(apply(mood({ stress: 80 }), [{ kind: "insult" }], office, monday).stress).toBe(84);
    expect(apply(mood({ stress: 80 }), [{ kind: "insult" }], office, SATURDAY).stress).toBe(90);
  });

  it("변동 이유를 최근 10개까지 남긴다", () => {
    const events: MoodEvent[] = Array.from({ length: 12 }, () => ({ kind: "slowTurn" }));
    const next = apply(mood(), events);
    expect(next.recentReasons).toHaveLength(10);
    expect(next.recentReasons[0]?.text).toBe("응답 지연");
  });
});

describe("decay", () => {
  it("반감기만큼 지나면 절반이 된다 (stress 30분, dopamine 15분)", () => {
    const start = mood({ stress: 80, dopamine: 80, updatedAt: WEDNESDAY.toISOString() });
    const after30 = decay(start, new Date(WEDNESDAY.getTime() + 30 * 60_000));
    expect(after30.stress).toBeCloseTo(40);
    const after15 = decay(start, new Date(WEDNESDAY.getTime() + 15 * 60_000));
    expect(after15.dopamine).toBeCloseTo(40);
  });

  it("updatedAt이 미래면 수치를 바꾸지 않는다", () => {
    const future = new Date(WEDNESDAY.getTime() + 60 * 60_000);
    const start = mood({ stress: 50, dopamine: -50, updatedAt: future.toISOString() });
    const next = decay(start, WEDNESDAY);
    expect(next.stress).toBe(50);
    expect(next.dopamine).toBe(-50);
  });
});

describe("readMood", () => {
  it("세기 경계는 30·60·85", () => {
    expect(readMood(29, -29)).toEqual({ direction: null, intensity: "calm" });
    expect(readMood(30, 0)).toEqual({ direction: "hot", intensity: "normal" });
    expect(readMood(0, -60).intensity).toBe("strong");
    expect(readMood(-85, 10).intensity).toBe("extreme");
  });

  it("방향은 stress·dopamine 부호로 정한다", () => {
    expect(readMood(50, 50).direction).toBe("hot");
    expect(readMood(50, -50).direction).toBe("cold");
    expect(readMood(-50, 50).direction).toBe("elated");
    expect(readMood(-50, -50).direction).toBe("sunken");
  });
});

describe("signFlips", () => {
  it("0을 지나 부호가 바뀐 축만 알려 준다", () => {
    expect(signFlips({ stress: 5, dopamine: -1 }, { stress: -2, dopamine: 3 })).toEqual([
      { axis: "stress", to: "negative" },
      { axis: "dopamine", to: "positive" },
    ]);
    expect(signFlips({ stress: 0, dopamine: 0 }, { stress: 4, dopamine: -1 })).toEqual([]);
  });
});

describe("advanceExtremeTurns", () => {
  it("극단이면 1 늘리고, 아니면 0으로", () => {
    expect(advanceExtremeTurns(mood({ stress: 90, extremeTurns: 2 })).extremeTurns).toBe(3);
    expect(advanceExtremeTurns(mood({ stress: 50, extremeTurns: 2 })).extremeTurns).toBe(0);
  });
});

describe("rememberPrompt", () => {
  it("최근 입력을 5개까지 남긴다", () => {
    let state = mood();
    for (const prompt of ["a", "b", "c", "d", "e", "f"]) {
      state = rememberPrompt(state, prompt);
    }
    expect(state.recentPrompts).toEqual(["b", "c", "d", "e", "f"]);
  });
});

describe("isWorkTime", () => {
  it("요일과 시각이 모두 맞을 때만 업무 시간", () => {
    expect(isWorkTime(OFFICE, new Date(2026, 10, 2, 9, 0))).toBe(true);
    expect(isWorkTime(OFFICE, new Date(2026, 10, 2, 18, 0))).toBe(false);
    expect(isWorkTime(OFFICE, SATURDAY)).toBe(false);
    expect(isWorkTime(null, MONDAY)).toBe(false);
  });
});

describe("parseMoodState", () => {
  it("저장한 상태를 그대로 읽는다", () => {
    const state = mood({ stress: 12 });
    expect(parseMoodState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("필드가 빠지거나 타입이 틀리면 undefined", () => {
    const { stress: _stress, ...missing } = mood();
    expect(parseMoodState(missing)).toBeUndefined();
    expect(parseMoodState({ ...mood(), dopamine: "x" })).toBeUndefined();
  });
});
