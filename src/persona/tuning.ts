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

// 기억(경험 기록) — docs/suberpowers/specs/2026-11-19-persona-memory-design.md 3.2
export const MEMORY_LIMIT = 300;
export const MEMORY_SESSION_LIMIT = 20;
export const RECORD_EVERY_TURNS = 10;
export const STARTUP_MEMORIES = 6;
/** 회상 기준 bigram 유사도. 써 보며 조정한다. */
export const RECALL_SIMILARITY = 0.35;
export const RECALL_MAX = 2;
export const RECALL_COOLDOWN_TURNS = 10;
/** 정규화한 입력이 이보다 짧으면 회상하지 않는다(짧은 글자의 우연한 일치 방지). */
export const RECALL_MIN_CHARS = 4;
/** 회상 이벤트 크기(중요도별). */
export const RECALL_DELTAS: Readonly<Record<1 | 2 | 3, number>> = { 1: 3, 2: 5, 3: 8 };
export const RECORD_TIMEOUT_MS = 60_000;
export const RECORD_BUDGET_USD = 0.05;
export const RECORD_MAX_FAILURES = 3;
/** 압축 후에는 원문을 읽을 수 없어 PreCompact에서 기록을 기다린다. */
export const PRECOMPACT_WAIT_MS = 20_000;
export const SESSION_STALE_DAYS = 30;
/** 런타임이 메모리에 두는 기분 표시점(극단 진입·탈출, 부호 전환) 수. */
export const MOOD_MARKERS = 20;
export const SEGMENT_LIMITS = { userChars: 1_000, assistantChars: 400, totalChars: 24_000 } as const;
export const RECENT_SUMMARIES_FOR_RECORD = 20;
export const SUMMARY_MAX = 120;
export const FEELING_MAX = 60;
/** 한 입력에서 판단기를 부르는 최대 횟수. 판단을 차례로 기다리므로 hook 시간 제한(30초)을 넘지 않게 한다. */
export const MAX_JUDGED_ACTIONS = 2;

export const PRAISE_KEYWORDS = ["잘했", "고마워", "고맙", "최고", "훌륭", "대단", "수고했", "좋아요", "멋지"] as const;
export const INSULT_KEYWORDS = ["멍청", "바보", "한심", "쓰레기", "꺼져", "닥쳐", "병신", "짜증나게"] as const;

export const TEST_COMMAND_PATTERN = /\b(npm (run )?test|vitest|jest|pytest|go test|cargo test)\b/;

/** 줄 전체가 괄호인 행동 묘사 줄. 안쪽 문장이 1번 그룹이다. */
export const ACTION_LINE_PATTERN = /^\s*\((.+)\)\s*$/;
