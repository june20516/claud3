/**
 * 인격 기분 계산에 쓰는 수치·패턴. 써 보면서 조정하기 쉽도록 한 곳에 모은다
 * (docs/suberpowers/specs/2026-11-05-persona-design.md 4장).
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** 이벤트별 기본 변화량(민감도·요일 배율 적용 전). toolFailure는 연속 실패 가산이 따로 있다. */
export const EVENT_DELTAS = {
  toolFailure: { stress: 4, dopamine: 0 },
  toolSuccess: { stress: -1, dopamine: 0 },
  testPassed: { stress: -3, dopamine: 6 },
  repeatedPrompt: { stress: 5, dopamine: 0 },
  slowTurn: { stress: 3, dopamine: 0 },
  praise: { stress: -4, dopamine: 8 },
  insult: { stress: 10, dopamine: -5 },
  afterHours: { stress: 3, dopamine: 0 },
  weekendStart: { stress: 5, dopamine: 0 },
  memoryPressure: { stress: 2, dopamine: 0 },
  cpuBusy: { stress: 1, dopamine: 0 },
  returnAfterBreak: { stress: 0, dopamine: 5 },
} as const;

/** 연속 실패 한 번마다 더하는 stress와 실패 이벤트 하나의 상한. */
export const FAILURE_STREAK_BONUS = 2;
export const FAILURE_EVENT_MAX = 10;

/** 민감도 1~5 → 배율. */
export const SENSITIVITY_MULTIPLIERS = [0.5, 0.75, 1, 1.5, 2] as const;

/** stress 증가분에만 곱하는 요일 배율(Date#getDay 기준: 1 월, 5 금). */
export const WEEKDAY_STRESS_MULTIPLIERS: Readonly<Record<number, number>> = { 1: 1.2, 5: 0.8 };

/** stress 변화량에 곱해 dopamine 반대 방향으로 더하는 비율. */
export const COUPLING = 0.3;

export const HALF_LIFE_MS = { stress: 30 * MINUTE_MS, dopamine: 15 * MINUTE_MS } as const;

export const MOOD_MIN = -100;
export const MOOD_MAX = 100;
/** 업무 시간 중 절댓값 상한(극단 구간 85에 닿지 못한다). */
export const WORK_HOURS_CAP = 84;

export const INTENSITY_THRESHOLDS = { normal: 30, strong: 60, extreme: 85 } as const;

export const REPEAT_SIMILARITY = 0.8;
export const RECENT_PROMPTS = 5;
export const RECENT_REASONS = 10;
export const SLOW_TURN_MS = 60_000;
export const BREAK_MS = 8 * HOUR_MS;
/** 메모리 여유율(%)이 이보다 낮으면 memoryPressure. */
export const MEMORY_AVAILABLE_LOW = 15;
/** 1분 loadavg ÷ 코어 수가 이보다 크면 cpuBusy. */
export const CPU_BUSY_RATIO = 0.8;
/** 반응 하나의 stress·dopamine 절댓값 상한. */
export const REACTION_LIMIT = 40;
export const JUDGE_TIMEOUT_MS = 10_000;

export const PRAISE_KEYWORDS = ["잘했", "고마워", "고맙", "최고", "훌륭", "대단", "수고했", "좋아요", "멋지"] as const;
export const INSULT_KEYWORDS = ["멍청", "바보", "한심", "쓰레기", "꺼져", "닥쳐", "병신", "짜증나게"] as const;

export const TEST_COMMAND_PATTERN = /\b(npm (run )?test|vitest|jest|pytest|go test|cargo test)\b/;

/** 줄 전체가 괄호인 행동 묘사 줄. 안쪽 문장이 1번 그룹이다. */
export const ACTION_LINE_PATTERN = /^\s*\((.+)\)\s*$/;
