import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import { extractActionLines } from "../../persona/actions.js";
import type { Intensity, MoodReading } from "../../persona/mood.js";
import type { Direction } from "../../persona/profile.js";
import type { PersonaRuntime, PersonaSnapshot } from "../../persona/runtime.js";
import type { UiEvent } from "../../types.js";

const METER_WIDTH = 10;
const CALM_FACE = "😐";
const FACES: Record<Direction, Record<Exclude<Intensity, "calm">, string>> = {
  hot: { normal: "😠", strong: "😤", extreme: "🤬" },
  cold: { normal: "😒", strong: "😞", extreme: "🫥" },
  elated: { normal: "🙂", strong: "😆", extreme: "🤪" },
  sunken: { normal: "😮‍💨", strong: "😩", extreme: "🫠" },
};

export function faceFor(reading: MoodReading): string {
  if (reading.direction === null || reading.intensity === "calm") {
    return CALM_FACE;
  }
  return FACES[reading.direction][reading.intensity];
}

/** 절댓값(0~100) 비율만큼 ▓, 나머지는 ░. */
export function meterBar(value: number, width: number): string {
  const filled = Math.min(width, Math.round((Math.abs(value) / 100) * width));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

/** 응답 글에서 마지막 행동 줄의 안쪽 문장. */
export function latestActionLine(text: string): string | undefined {
  return extractActionLines(text).at(-1);
}

function signed(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) {
    return "0";
  }
  return rounded > 0 ? `+${rounded}` : `−${Math.abs(rounded)}`;
}

export interface PersonaPanelProps {
  snapshot: PersonaSnapshot;
  latestAction: string | undefined;
}

/** 입력창 위 캐릭터 패널: 1줄째 이름·얼굴·수치 막대, 2줄째 최근 행동. */
export function PersonaPanel({ snapshot, latestAction }: PersonaPanelProps) {
  const { profile, state, reading } = snapshot;
  const stress = `S ${meterBar(state.stress, METER_WIDTH)} ${signed(state.stress)}`;
  const dopamine = `D ${meterBar(state.dopamine, METER_WIDTH)} ${signed(state.dopamine)}`;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">{`${profile.displayName} ${faceFor(reading)}  ${stress}  ${dopamine}`}</Text>
      {latestAction !== undefined && (
        <Text dimColor italic wrap="truncate">{`(${latestAction})`}</Text>
      )}
    </Box>
  );
}

type PersonaSource = Pick<PersonaRuntime, "snapshot" | "subscribe">;
type EventSource = { onEvent(listener: (event: UiEvent) => void): void };

function usePersonaSnapshot(persona: PersonaSource): PersonaSnapshot {
  const [snapshot, setSnapshot] = useState(() => persona.snapshot());
  useEffect(() => persona.subscribe(setSnapshot), [persona]);
  return snapshot;
}

/**
 * 응답 글에서 완성된(줄바꿈으로 끝난) 마지막 행동 줄을 고른다. 턴이 끝나도 다음 행동이 나올 때까지 남긴다.
 * 스트리밍 조각마다 setState하지 않고 값이 바뀔 때만 한다(연속 갱신은 Ink에서 "Maximum update depth"를 일으킨다).
 */
function useLatestAction(session: EventSource): string | undefined {
  const [latestAction, setLatestAction] = useState<string | undefined>(undefined);
  const turnText = useRef("");
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    let active = true;
    // Session.onEvent에는 해제 함수가 없어 active 플래그로 막는다.
    session.onEvent((event) => {
      if (!active) {
        return;
      }
      const show = (text: string): void => {
        const action = latestActionLine(text);
        if (action !== undefined && action !== shown.current) {
          shown.current = action;
          setLatestAction(action);
        }
      };
      if (event.type === "turn_result") {
        // 줄바꿈 없이 끝난 마지막 줄도 턴이 끝나면 완성된 것이다.
        show(turnText.current);
        turnText.current = "";
        return;
      }
      if (event.type !== "text_delta") {
        return;
      }
      turnText.current += event.text;
      show(turnText.current.slice(0, turnText.current.lastIndexOf("\n") + 1));
    });
    return () => {
      active = false;
    };
  }, [session]);
  return latestAction;
}

export interface PersonaPanelContainerProps {
  persona: PersonaSource;
  session: EventSource;
}

/** 인격 상태를 구독하고 응답 글에서 최근 행동을 뽑아 패널을 그린다. */
export function PersonaPanelContainer({ persona, session }: PersonaPanelContainerProps) {
  const snapshot = usePersonaSnapshot(persona);
  const latestAction = useLatestAction(session);
  return <PersonaPanel snapshot={snapshot} latestAction={latestAction} />;
}
