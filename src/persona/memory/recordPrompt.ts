import { isRecord } from "../guards.js";
import type { PersonaProfile } from "../profile.js";
import { sliceChars } from "../text.js";
import { FEELING_MAX, SUMMARY_MAX } from "../tuning.js";
import type { Experience, SegmentMood } from "./experience.js";
import type { Segment } from "./segment.js";

const MAX_RECORDED = 3;

export const RECORD_SCHEMA = {
  type: "object",
  properties: {
    experiences: {
      type: "array",
      maxItems: MAX_RECORDED,
      items: {
        type: "object",
        properties: {
          summary: { type: "string" },
          feeling: { type: "string" },
          importance: { type: "integer", enum: [1, 2, 3] },
        },
        required: ["summary", "feeling", "importance"],
        additionalProperties: false,
      },
    },
  },
  required: ["experiences"],
  additionalProperties: false,
} as const;

export interface RecordPromptInput {
  profile: PersonaProfile;
  segment: Segment;
  mood: SegmentMood;
  recentSummaries: string[];
}

export type RecordedItem = Pick<Experience, "summary" | "feeling" | "importance">;

function section(title: string, lines: string[]): string[] {
  return ["", `## ${title}`, ...lines];
}

/** 대화 구간에서 인격이 기억할 일을 고르게 하는 프롬프트(spec 4.4·4.5). */
export function buildRecordPrompt({ profile, segment, mood, recentSummaries }: RecordPromptInput): string {
  const name = profile.displayName;
  const lines = [
    `너는 "${name}"의 일기를 대신 정리한다. ${name}: ${profile.summary}. 사용자와의 관계: ${profile.relationship}.`,
    `말투 예시: ${profile.speechExamples.join(" / ")}`,
    `말버릇: ${profile.catchphrases.join(" / ")}`,
    "",
    `아래는 ${name}와(과) 사용자의 대화 한 구간이다. 이 구간에서 ${name}이(가) 오래 기억할 만한 일을 0~3개 고른다.`,
    ...section("고르는 기준", [
      "들어가는 것:",
      "- 감정이 크게 움직인 순간(극단 진입·탈출, 큰 변동)",
      "- 처음 있는 일",
      "- 사용자와의 관계가 드러난 일(칭찬, 꾸중, 농담, 부탁)",
      "- 막혔다가 넘긴 일",
      `- ${name}의 실수`,
      "- 대화 흐름이 크게 바뀐 일(작업하다 잡담으로 샌 일, 계획을 엎은 일)",
      "들어가지 않는 것: 평범한 성공·반복 작업, 기억에 이미 있는 것과 같은 종류의 일, 작업 내용 자체(코드 세부사항).",
      "기본값은 0개다. 기준에 분명히 해당할 때만 고른다. 고를 것이 없으면 빈 배열을 낸다.",
    ]),
    ...section("중요도", [
      "- 3: 기준에 강하게 해당, 오래 기억할 일(극단 진입·탈출, 진지한 칭찬·꾸중, 처음 겪은 큰 일)",
      "- 2: 기준에 분명히 해당(막혔다가 넘긴 일, 실수, 가벼운 농담·부탁, 큰 흐름 전환)",
      "- 1: 기준에 걸치지만 약함(기분이 조금 움직인 평범한 일)",
    ]),
    ...section("쓰는 법", [
      `- summary: 무슨 일이 있었는지 사실만, ${SUMMARY_MAX}자 이내, "…했다"처럼 과거형으로.`,
      `- feeling: ${name}의 말투로 쓴 한 줄 소감, ${FEELING_MAX}자 이내.`,
    ]),
  ];
  if (recentSummaries.length > 0) {
    lines.push(...section("이미 기억하는 일 (같은 종류는 고르지 않는다)", recentSummaries.map((summary) => `- ${summary}`)));
  }
  const moodLines = [`이유: ${mood.moodReasons.length > 0 ? mood.moodReasons.join(", ") : "(없음)"}`];
  if (mood.strongHints.length > 0) {
    moodLines.push(
      `강한 후보: ${mood.strongHints.join(", ")} — 이 시간대에 감정이 크게 움직였다. 관련된 일이 있으면 중요도 3의 근거가 된다.`,
    );
  }
  lines.push(...section("이 구간의 기분 변화", moodLines));
  if (segment.context.length > 0) {
    lines.push(...section("앞 구간 (참고용, 기록 대상 아님)", segment.context));
  }
  lines.push(...section("대화 구간", segment.lines));
  return lines.join("\n");
}


function parseItem(value: unknown): RecordedItem | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { summary, feeling, importance } = value;
  if (typeof summary !== "string" || summary.trim() === "" || typeof feeling !== "string") {
    return undefined;
  }
  if (importance !== 1 && importance !== 2 && importance !== 3) {
    return undefined;
  }
  return { summary: sliceChars(summary.trim(), SUMMARY_MAX), feeling: sliceChars(feeling.trim(), FEELING_MAX), importance };
}

/** 형식이 아예 틀리면 undefined(실패). 깨진 항목은 버리고 유효한 앞 3개, 긴 글은 자른다. */
export function parseRecordOutput(output: unknown): RecordedItem[] | undefined {
  if (!isRecord(output) || !Array.isArray(output.experiences)) {
    return undefined;
  }
  return output.experiences.flatMap((item) => parseItem(item) ?? []).slice(0, MAX_RECORDED);
}
