import type { Direction, PersonaProfile, WorkHours } from "./profile.js";
import {
  COUPLING,
  EVENT_DELTAS,
  FAILURE_EVENT_MAX,
  FAILURE_STREAK_BONUS,
  HALF_LIFE_MS,
  INTENSITY_THRESHOLDS,
  MOOD_MAX,
  RECENT_PROMPTS,
  RECENT_REASONS,
  SENSITIVITY_MULTIPLIERS,
  WEEKDAY_STRESS_MULTIPLIERS,
  WORK_HOURS_CAP,
} from "./tuning.js";

export interface MoodReason {
  at: string;
  text: string;
  stress: number;
  dopamine: number;
}

/** 실행 중 판단한 사용자 행동 반응의 기억. action은 정규화한 행동 문장이다. */
export interface LearnedReaction {
  action: string;
  stress: number;
  dopamine: number;
  note: string;
}

export interface MoodState {
  version: 1;
  stress: number;
  dopamine: number;
  updatedAt: string;
  lastSessionStartAt: string | null;
  extremeTurns: number;
  failureStreak: number;
  recentPrompts: string[];
  recentReasons: MoodReason[];
  learnedReactions: LearnedReaction[];
}

export type MoodEventKind = keyof typeof EVENT_DELTAS | "userAction";

export type MoodEvent =
  | { kind: Exclude<MoodEventKind, "userAction"> }
  | { kind: "userAction"; action: string; stress: number; dopamine: number };

export type Intensity = "calm" | "normal" | "strong" | "extreme";

export interface MoodReading {
  direction: Direction | null;
  intensity: Intensity;
}

export interface SignFlip {
  axis: "stress" | "dopamine";
  to: "positive" | "negative";
}

/** 변동 이유 문구. userAction은 행동 문장을 그대로 쓴다. */
export const EVENT_LABELS: Record<Exclude<MoodEventKind, "userAction">, string> = {
  toolFailure: "도구 실패",
  toolSuccess: "도구 성공",
  testPassed: "테스트 통과",
  repeatedPrompt: "같은 요청 반복",
  slowTurn: "응답 지연",
  praise: "칭찬",
  insult: "욕설",
  afterHours: "퇴근 시간 이후",
  weekendStart: "주말 출근",
  memoryPressure: "메모리 부족",
  cpuBusy: "CPU 과부하",
  returnAfterBreak: "오랜만의 재회",
};

export function initialMood(now: Date): MoodState {
  return {
    version: 1,
    stress: 0,
    dopamine: 0,
    updatedAt: now.toISOString(),
    lastSessionStartAt: null,
    extremeTurns: 0,
    failureStreak: 0,
    recentPrompts: [],
    recentReasons: [],
    learnedReactions: [],
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isReason(value: unknown): value is MoodReason {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { at, text, stress, dopamine } = value as Record<string, unknown>;
  return typeof at === "string" && typeof text === "string" && isFiniteNumber(stress) && isFiniteNumber(dopamine);
}

function isLearnedReaction(value: unknown): value is LearnedReaction {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { action, stress, dopamine, note } = value as Record<string, unknown>;
  return typeof action === "string" && typeof note === "string" && isFiniteNumber(stress) && isFiniteNumber(dopamine);
}

/** 기분 파일 내용을 검사한다. 하나라도 형식이 틀리면 undefined. */
export function parseMoodState(value: unknown): MoodState | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const valid =
    record.version === 1 &&
    isFiniteNumber(record.stress) &&
    isFiniteNumber(record.dopamine) &&
    typeof record.updatedAt === "string" &&
    !Number.isNaN(Date.parse(record.updatedAt)) &&
    (record.lastSessionStartAt === null || typeof record.lastSessionStartAt === "string") &&
    isFiniteNumber(record.extremeTurns) &&
    isFiniteNumber(record.failureStreak) &&
    isStringArray(record.recentPrompts) &&
    Array.isArray(record.recentReasons) &&
    record.recentReasons.every(isReason) &&
    Array.isArray(record.learnedReactions) &&
    record.learnedReactions.every(isLearnedReaction);
  return valid ? (record as unknown as MoodState) : undefined;
}

function minutesOfDay(time: string): number {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

/** 업무 요일이고 start 이상 end 미만이면 업무 시간이다. */
export function isWorkTime(workHours: WorkHours | null, now: Date): boolean {
  if (workHours === null || !workHours.days.includes(now.getDay())) {
    return false;
  }
  const current = now.getHours() * 60 + now.getMinutes();
  return current >= minutesOfDay(workHours.start) && current < minutesOfDay(workHours.end);
}

/** 마지막 갱신 이후 흐른 시간만큼 0으로 지수 감쇠한다. 시계가 거꾸로 가면 감쇠하지 않는다. */
export function decay(state: MoodState, now: Date): MoodState {
  const elapsedMs = Math.max(0, now.getTime() - Date.parse(state.updatedAt));
  return {
    ...state,
    stress: state.stress * 0.5 ** (elapsedMs / HALF_LIFE_MS.stress),
    dopamine: state.dopamine * 0.5 ** (elapsedMs / HALF_LIFE_MS.dopamine),
    updatedAt: now.toISOString(),
  };
}

function sensitivityMultiplier(level: number): number {
  return SENSITIVITY_MULTIPLIERS[level - 1] ?? 1;
}

/** limit은 MOOD_MAX(100) 이하다. 업무 시간이면 WORK_HOURS_CAP. */
function clamp(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

/** 민감도·요일 배율과 연속 실패 가산을 적용한 이벤트 자체의 변화량. */
function eventDelta(state: MoodState, event: MoodEvent, profile: PersonaProfile, now: Date): { stress: number; dopamine: number } {
  if (event.kind === "userAction") {
    return { stress: event.stress, dopamine: event.dopamine };
  }
  const base = EVENT_DELTAS[event.kind];
  const baseStress =
    event.kind === "toolFailure"
      ? Math.min(base.stress + FAILURE_STREAK_BONUS * state.failureStreak, FAILURE_EVENT_MAX)
      : base.stress;
  let stress = baseStress * sensitivityMultiplier(profile.sensitivity.stress);
  if (stress > 0) {
    stress *= WEEKDAY_STRESS_MULTIPLIERS[now.getDay()] ?? 1;
  }
  return { stress, dopamine: base.dopamine * sensitivityMultiplier(profile.sensitivity.dopamine) };
}

function nextFailureStreak(state: MoodState, event: MoodEvent): number {
  if (event.kind === "toolFailure") {
    return state.failureStreak + 1;
  }
  if (event.kind === "toolSuccess" || event.kind === "testPassed") {
    return 0;
  }
  return state.failureStreak;
}

/** spec 4.2 순서: 민감도 → 요일 → 커플링 → 범위·업무 시간 상한. */
export function applyEvent(state: MoodState, event: MoodEvent, profile: PersonaProfile, now: Date): MoodState {
  const delta = eventDelta(state, event, profile, now);
  const coupledDopamine = delta.dopamine - COUPLING * delta.stress;
  const limit = isWorkTime(profile.workHours, now) ? WORK_HOURS_CAP : MOOD_MAX;
  const stress = clamp(state.stress + delta.stress, limit);
  const dopamine = clamp(state.dopamine + coupledDopamine, limit);

  const appliedStress = stress - state.stress;
  const appliedDopamine = dopamine - state.dopamine;
  const reason: MoodReason = {
    at: now.toISOString(),
    text: event.kind === "userAction" ? event.action : EVENT_LABELS[event.kind],
    stress: appliedStress,
    dopamine: appliedDopamine,
  };
  const changed = appliedStress !== 0 || appliedDopamine !== 0 || event.kind === "userAction";
  return {
    ...state,
    stress,
    dopamine,
    updatedAt: now.toISOString(),
    failureStreak: nextFailureStreak(state, event),
    recentReasons: changed ? [...state.recentReasons, reason].slice(-RECENT_REASONS) : state.recentReasons,
  };
}

export function readMood(stress: number, dopamine: number): MoodReading {
  const magnitude = Math.max(Math.abs(stress), Math.abs(dopamine));
  if (magnitude < INTENSITY_THRESHOLDS.normal) {
    return { direction: null, intensity: "calm" };
  }
  const intensity: Intensity =
    magnitude < INTENSITY_THRESHOLDS.strong ? "normal" : magnitude < INTENSITY_THRESHOLDS.extreme ? "strong" : "extreme";
  const direction: Direction =
    stress >= 0 ? (dopamine >= 0 ? "hot" : "cold") : dopamine >= 0 ? "elated" : "sunken";
  return { direction, intensity };
}

type MoodValues = Pick<MoodState, "stress" | "dopamine">;

/** 0을 지나 부호가 바뀐 축. 0에서 출발하거나 0에 도착한 것은 전환이 아니다. */
export function signFlips(before: MoodValues, after: MoodValues): SignFlip[] {
  const flips: SignFlip[] = [];
  for (const axis of ["stress", "dopamine"] as const) {
    if (Math.sign(before[axis]) * Math.sign(after[axis]) < 0) {
      flips.push({ axis, to: after[axis] > 0 ? "positive" : "negative" });
    }
  }
  return flips;
}

export function advanceExtremeTurns(state: MoodState): MoodState {
  const isExtreme = readMood(state.stress, state.dopamine).intensity === "extreme";
  return { ...state, extremeTurns: isExtreme ? state.extremeTurns + 1 : 0 };
}

export function rememberPrompt(state: MoodState, normalizedPrompt: string): MoodState {
  return { ...state, recentPrompts: [...state.recentPrompts, normalizedPrompt].slice(-RECENT_PROMPTS) };
}
