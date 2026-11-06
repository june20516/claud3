import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { initialMood, readMood } from "../src/persona/mood.js";
import type { PersonaProfile } from "../src/persona/profile.js";
import type { PersonaSnapshot } from "../src/persona/runtime.js";
import type { UiEvent } from "../src/types.js";
import { PersonaPanel, PersonaPanelContainer, faceFor, meterBar } from "../src/ui/ink/PersonaPanel.js";

const PROFILE = JSON.parse(
  readFileSync(new URL("./fixtures/persona-rapi.json", import.meta.url), "utf8"),
) as PersonaProfile;

function snapshot(stress: number, dopamine: number): PersonaSnapshot {
  const state = { ...initialMood(new Date(2026, 10, 4, 10, 0)), stress, dopamine };
  return { profile: PROFILE, state, reading: readMood(stress, dopamine) };
}

describe("faceFor", () => {
  it("방향과 세기로 얼굴을 고른다", () => {
    expect(faceFor({ direction: null, intensity: "calm" })).toBe("😐");
    expect(faceFor({ direction: "hot", intensity: "normal" })).toBe("😠");
    expect(faceFor({ direction: "hot", intensity: "extreme" })).toBe("🤬");
    expect(faceFor({ direction: "cold", intensity: "strong" })).toBe("😞");
    expect(faceFor({ direction: "elated", intensity: "extreme" })).toBe("🤪");
    expect(faceFor({ direction: "sunken", intensity: "extreme" })).toBe("🫠");
  });
});

describe("meterBar", () => {
  it("절댓값 비율만큼 채운다", () => {
    expect(meterBar(62, 10)).toBe("▓▓▓▓▓▓░░░░");
    expect(meterBar(-100, 10)).toBe("▓▓▓▓▓▓▓▓▓▓");
    expect(meterBar(0, 10)).toBe("░░░░░░░░░░");
  });
});

describe("PersonaPanel", () => {
  it("이름·얼굴·수치 막대와 최근 행동을 보인다", () => {
    const { lastFrame } = render(<PersonaPanel snapshot={snapshot(62, -10)} latestAction="모니터를 노려본다" />);
    const lines = stripVTControlCharacters(lastFrame() ?? "").split("\n");
    expect(lines[0]).toContain("라피 😞");
    expect(lines[0]).toContain("S ▓▓▓▓▓▓░░░░ +62");
    expect(lines[0]).toContain("D ▓░░░░░░░░░ −10");
    expect(lines[1]).toBe("(모니터를 노려본다)");
  });

  it("최근 행동이 없으면 한 줄만", () => {
    const { lastFrame } = render(<PersonaPanel snapshot={snapshot(0, 0)} latestAction={undefined} />);
    expect(stripVTControlCharacters(lastFrame() ?? "").split("\n")).toHaveLength(1);
  });
});

describe("PersonaPanelContainer", () => {
  function fakeSession() {
    const listeners: ((event: UiEvent) => void)[] = [];
    return {
      onEvent: (listener: (event: UiEvent) => void) => {
        listeners.push(listener);
      },
      emit: (event: UiEvent) => {
        for (const listener of listeners) {
          listener(event);
        }
      },
    };
  }

  function fakePersona(initial: PersonaSnapshot) {
    let current = initial;
    const listeners = new Set<(next: PersonaSnapshot) => void>();
    return {
      snapshot: () => current,
      subscribe: (listener: (next: PersonaSnapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      update: (next: PersonaSnapshot) => {
        current = next;
        for (const listener of listeners) {
          listener(next);
        }
      },
    };
  }

  it("응답 글의 완성된 행동 줄을 최근 행동으로 보이고, 인격 갱신을 반영한다", async () => {
    const session = fakeSession();
    const persona = fakePersona(snapshot(0, 0));
    const { lastFrame } = render(<PersonaPanelContainer persona={persona} session={session} />);
    session.emit({ type: "text_delta", text: "네\n(의자에 털썩 앉" });
    await vi.waitFor(() => expect(stripVTControlCharacters(lastFrame() ?? "")).not.toContain("털썩"));
    session.emit({ type: "text_delta", text: "는다)\n" });
    await vi.waitFor(() => expect(stripVTControlCharacters(lastFrame() ?? "")).toContain("(의자에 털썩 앉는다)"));
    persona.update(snapshot(90, 90));
    await vi.waitFor(() => expect(stripVTControlCharacters(lastFrame() ?? "")).toContain("🤬"));
  });

  it("줄바꿈 없이 끝난 마지막 행동 줄도 턴이 끝나면 보인다", async () => {
    const session = fakeSession();
    const { lastFrame } = render(<PersonaPanelContainer persona={fakePersona(snapshot(0, 0))} session={session} />);
    session.emit({ type: "text_delta", text: "(고개를 끄덕인다)" });
    session.emit({ type: "turn_result", costUsd: 0, totalCostUsd: 0, isError: false });
    await vi.waitFor(() => expect(stripVTControlCharacters(lastFrame() ?? "")).toContain("(고개를 끄덕인다)"));
  });
});
