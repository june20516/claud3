import type { LearnedReaction, MoodEvent, MoodState } from "./mood.js";
import { runStructuredQuery } from "./oneShot.js";
import type { OneShotQueryFn } from "./oneShot.js";
import { DIRECTIONS } from "./profile.js";
import type { PersonaProfile } from "./profile.js";
import { normalizePrompt } from "./turnEvents.js";
import { ACTION_LINE_PATTERN, JUDGE_TIMEOUT_MS, REACTION_LIMIT } from "./tuning.js";

const CODE_FENCE = "```";
const JUDGE_MODEL = "claude-haiku-5-5";
const ONE_SHOT_MAX_TURNS = 3;

/** 코드 블록 밖에서 줄 전체가 괄호인 줄의 안쪽 문장. */
export function extractActionLines(text: string): string[] {
  const actions: string[] = [];
  let inCodeBlock = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith(CODE_FENCE)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    const match = inCodeBlock ? null : ACTION_LINE_PATTERN.exec(line);
    if (match?.[1] !== undefined) {
      actions.push(match[1].trim());
    }
  }
  return actions;
}

/** 인격이 이 행동에 어떻게 반응할지 판단한다. 판단하지 못하면 undefined. */
export type ReactionJudge = (params: {
  profile: PersonaProfile;
  state: MoodState;
  action: string;
  signal: AbortSignal;
}) => Promise<LearnedReaction | undefined>;

export interface ResolvedActions {
  events: MoodEvent[];
  /** 이번에 새로 판단해 기억할 반응. */
  learned: LearnedReaction[];
}

function userAction(action: string, stress: number, dopamine: number): MoodEvent {
  return { kind: "userAction", action, stress, dopamine };
}

/** 시간 안에 판단하지 못하거나 실패하면 undefined. 시간이 지나면 판단기를 abort한다. */
async function judgeWithTimeout(
  judge: ReactionJudge,
  params: Omit<Parameters<ReactionJudge>[0], "signal">,
): Promise<LearnedReaction | undefined> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, JUDGE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([judge({ ...params, signal: controller.signal }).catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** spec 5장 순서: 인격의 반응 키워드 → 기억한 반응 → 판단기. */
export async function resolveReactions(
  actions: string[],
  profile: PersonaProfile,
  state: MoodState,
  judge: ReactionJudge,
): Promise<ResolvedActions> {
  const events: MoodEvent[] = [];
  const learned: LearnedReaction[] = [];
  for (const action of actions) {
    const known = profile.reactions.find((reaction) => reaction.keywords.some((keyword) => action.includes(keyword)));
    if (known !== undefined) {
      events.push(userAction(action, known.stress, known.dopamine));
      continue;
    }
    const normalized = normalizePrompt(action);
    const remembered = [...state.learnedReactions, ...learned].find((reaction) => reaction.action === normalized);
    if (remembered !== undefined) {
      events.push(userAction(action, remembered.stress, remembered.dopamine));
      continue;
    }
    const judged = await judgeWithTimeout(judge, { profile, state, action });
    if (judged === undefined) {
      events.push(userAction(action, 0, 0));
      continue;
    }
    learned.push({ ...judged, action: normalized });
    events.push(userAction(action, judged.stress, judged.dopamine));
  }
  return { events, learned };
}

const REACTION_SCHEMA = {
  type: "object",
  properties: {
    stress: { type: "integer", minimum: -REACTION_LIMIT, maximum: REACTION_LIMIT },
    dopamine: { type: "integer", minimum: -REACTION_LIMIT, maximum: REACTION_LIMIT },
    note: { type: "string" },
  },
  required: ["stress", "dopamine", "note"],
  additionalProperties: false,
} as const;

function buildJudgePrompt(profile: PersonaProfile, state: MoodState, action: string): string {
  const tendencies = DIRECTIONS.map(
    (direction) =>
      `- ${direction}: ${profile.directions[direction].normal.tendency} / 극단: ${profile.directions[direction].extreme.tendency}`,
  );
  const reactions = profile.reactions.map(
    (reaction) => `- ${reaction.keywords.join(", ")}: stress ${reaction.stress}, dopamine ${reaction.dopamine} (${reaction.note})`,
  );
  return [
    `캐릭터 "${profile.displayName}": ${profile.summary}`,
    `사용자와의 관계: ${profile.relationship}`,
    "기분 방향별 성향:",
    ...tendencies,
    "이미 정해진 반응:",
    ...(reactions.length > 0 ? reactions : ["- 없음"]),
    `현재 stress ${Math.round(state.stress)}, dopamine ${Math.round(state.dopamine)} (−100~100)`,
    "",
    `사용자가 이 캐릭터에게 한 행동: "${action}"`,
    `이 캐릭터라면 이 행동에 어떻게 반응할지 stress·dopamine 변화(−${REACTION_LIMIT}~${REACTION_LIMIT} 정수)와 한 문장 note로 답하세요.`,
    "싫어하는 행동이면 stress를 올려도 됩니다.",
    '답은 {"stress": 정수, "dopamine": 정수, "note": "문장"} JSON 하나로만 합니다.',
  ].join("\n");
}

function clampReaction(value: number): number {
  return Math.max(-REACTION_LIMIT, Math.min(REACTION_LIMIT, Math.round(value)));
}

function parseJudgeOutput(output: unknown): { stress: number; dopamine: number; note: string } | undefined {
  if (typeof output !== "object" || output === null) {
    return undefined;
  }
  const { stress, dopamine, note } = output as Record<string, unknown>;
  if (typeof stress !== "number" || typeof dopamine !== "number" || !Number.isFinite(stress) || !Number.isFinite(dopamine)) {
    return undefined;
  }
  return { stress: clampReaction(stress), dopamine: clampReaction(dopamine), note: typeof note === "string" ? note : "" };
}

/** Haiku 한 번으로 반응을 판단한다. 도구 없이, 사용자 설정(hook·플러그인)과 격리해 부른다. */
export function createReactionJudge(
  queryFn: OneShotQueryFn,
  env: Record<string, string | undefined>,
  onCost: (usd: number) => void,
): ReactionJudge {
  return async ({ profile, state, action, signal }) => {
    const abortController = new AbortController();
    signal.addEventListener("abort", () => abortController.abort(), { once: true });
    const { output, costUsd } = await runStructuredQuery(queryFn, buildJudgePrompt(profile, state, action), {
      model: JUDGE_MODEL,
      tools: [],
      settingSources: [],
      // 구조화 출력은 내부 도구 호출로 끝나므로 1턴으로는 모자랄 수 있다.
      maxTurns: ONE_SHOT_MAX_TURNS,
      env,
      abortController,
      outputFormat: { type: "json_schema", schema: REACTION_SCHEMA },
    });
    onCost(costUsd);
    const parsed = parseJudgeOutput(output);
    return parsed === undefined ? undefined : { action, ...parsed };
  };
}
