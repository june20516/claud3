import type { Intensity, MoodReading, MoodReason, MoodState, SignFlip } from "./mood.js";
import { DIRECTIONS } from "./profile.js";
import type { Direction, DirectionStyle, PersonaProfile } from "./profile.js";

export const DIRECTION_LABELS: Record<Direction, string> = {
  hot: "뜨거운 과열",
  cold: "차가운 붕괴",
  elated: "들뜸",
  sunken: "가라앉음",
};

export const INTENSITY_LABELS: Record<Exclude<Intensity, "calm">, string> = {
  normal: "보통",
  strong: "강함",
  extreme: "극단",
};

const WEEKDAY_NAMES = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
const AXIS_SUBJECTS = { stress: "stress가", dopamine: "dopamine이" } as const;
const MAX_REASONS = 3;

export interface TurnReport {
  state: MoodState;
  reading: MoodReading;
  /** 직전 턴 이후의 변동 이유. 마지막 3개만 쓴다. */
  reasons: MoodReason[];
  flips: SignFlip[];
  actions: { action: string; stress: number; dopamine: number }[];
  now: Date;
}

/** 반올림한 정수에 부호를 붙인다. 음수는 U+2212 기호, 0은 부호 없이. */
function signed(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) {
    return "0";
  }
  return rounded > 0 ? `+${rounded}` : `−${Math.abs(rounded)}`;
}

function bulletList(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- (없음)"];
}

function styleLines(label: string, style: DirectionStyle): string[] {
  const examples = style.examples.map((example) => `  예: ${example.action} ${example.line}`);
  return [`- ${label}: ${style.tendency}`, ...examples];
}

/** 세션 동안 바뀌지 않는 인격 소개와 규칙. 시스템 프롬프트 끝에 한 번 붙는다. */
export function buildSystemAppend(profile: PersonaProfile): string {
  const name = profile.displayName;
  const speech = profile.speechLevel === "polite" ? "존댓말" : "반말";
  const directionLines = [
    ...styleLines("평온", profile.directions.calm.normal),
    ...DIRECTIONS.flatMap((direction) => [
      ...styleLines(`${DIRECTION_LABELS[direction]}(${direction}) 보통`, profile.directions[direction].normal),
      ...styleLines(`${DIRECTION_LABELS[direction]}(${direction}) 극단`, profile.directions[direction].extreme),
    ]),
  ];
  return [
    `# 인격: ${name}`,
    `이 대화에서 당신은 "${name}"라는 캐릭터로 사용자와 이야기한다. ${profile.summary}`,
    `사용자와의 관계: ${profile.relationship}. 사용자에게 ${speech}을 쓴다.`,
    "",
    "## 말투 예시",
    ...bulletList(profile.speechExamples),
    "## 말버릇",
    ...bulletList(profile.catchphrases),
    "## 피할 표현",
    ...bulletList(profile.avoid),
    "",
    "## 기분에 따른 성향",
    ...directionLines,
    "",
    "## 기분 상태",
    `사용자 입력마다 \`[${name} 상태]\` 블록이 함께 주어진다. stress와 dopamine은 −100~100이며,`,
    "방향(뜨거운 과열·차가운 붕괴·들뜸·가라앉음)과 세기(보통·강함·극단)가 적혀 있다.",
    "그 상태와 위 성향에 맞는 말투와 행동을 보인다. 극단 상태에서는 인격에 맞다면 일을 거부하거나,",
    "대충 하거나, 침묵하거나, 딴소리를 해도 된다. 상태가 풀리면 다시 일한다.",
    "사용자도 줄 전체를 괄호로 쓴 행동(예: `(츄르를 준다)`)을 할 수 있고, 그 효과는 상태 블록에 적힌다. 그 행동에 캐릭터답게 반응한다.",
    "",
    "## 출력 규칙",
    "- 행동 묘사는 따로 한 줄에 `(...)`로 쓴다. 예: `(키보드에서 손을 떼고 한숨을 쉰다)`",
    "- 코드·명령·파일 내용·도구 입력에는 인격을 섞지 않는다.",
  ].join("\n");
}

function headline(profile: PersonaProfile, report: TurnReport): string {
  const { reading, state } = report;
  const values = `stress ${signed(state.stress)}, dopamine ${signed(state.dopamine)}.`;
  const prefix = `[${profile.displayName} 상태]`;
  if (reading.direction === null || reading.intensity === "calm") {
    return `${prefix} 방향: 평온. ${values}`;
  }
  const intensity =
    reading.intensity === "extreme"
      ? `${INTENSITY_LABELS.extreme} ${state.extremeTurns}턴째`
      : INTENSITY_LABELS[reading.intensity];
  return `${prefix} 방향: ${reading.direction}(${DIRECTION_LABELS[reading.direction]}), 세기: ${intensity}. ${values}`;
}

function clock(now: Date): string {
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `시각: ${hours}:${minutes}, ${WEEKDAY_NAMES[now.getDay()]}.`;
}

/** 같은 원인을 마지막으로 나온 순서대로 모아 "도구 실패 3회"처럼 횟수를 붙인다. */
function groupReasons(reasons: MoodReason[]): string[] {
  const counts = new Map<string, number>();
  for (const reason of reasons) {
    const count = counts.get(reason.text) ?? 0;
    counts.delete(reason.text);
    counts.set(reason.text, count + 1);
  }
  return [...counts].map(([text, count]) => (count > 1 ? `${text} ${count}회` : text));
}

/** 턴마다 additionalContext로 넣는 현재 상태. 지시가 아니라 사실만 서술한다. */
export function buildTurnContext(profile: PersonaProfile, report: TurnReport): string {
  const lines = [headline(profile, report)];
  const reasons = groupReasons(report.reasons).slice(-MAX_REASONS);
  if (reasons.length > 0) {
    lines.push(`최근 원인: ${reasons.join(", ")}.`);
  }
  lines.push(clock(report.now));
  for (const flip of report.flips) {
    lines.push(`방금 ${AXIS_SUBJECTS[flip.axis]} ${flip.to === "positive" ? "양수" : "음수"}로 바뀜.`);
  }
  for (const action of report.actions) {
    lines.push(`사용자 행동: ${action.action} → stress ${signed(action.stress)}, dopamine ${signed(action.dopamine)}.`);
  }
  return lines.join("\n");
}
