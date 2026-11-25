import type { MoodEvent, MoodReason } from "../mood.js";
import {
  FEELING_MAX,
  MEMORY_LIMIT,
  MEMORY_SESSION_LIMIT,
  RECALL_COOLDOWN_TURNS,
  RECALL_DELTAS,
  RECALL_MAX,
  RECALL_MIN_CHARS,
  RECALL_SIMILARITY,
  SESSION_STALE_DAYS,
  STARTUP_MEMORIES,
  SUMMARY_MAX,
} from "../tuning.js";
import { sliceChars } from "../text.js";
import { bigramSimilarity, normalizePrompt } from "../turnEvents.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type Importance = 1 | 2 | 3;

/** 인격이 기억하는 일 하나. 근거(세션·기분 변화)를 함께 둔다. */
export interface Experience {
  id: string;
  summary: string;
  /** 인격의 말투로 쓴 한 줄 소감. */
  feeling: string;
  importance: Importance;
  at: string;
  sessionId: string;
  moodReasons: string[];
  moodDelta: { stress: number; dopamine: number };
}

/** 이 인격이 켜졌던 세션과 기록 커서. */
export interface TrackedSession {
  sessionId: string;
  cwd: string;
  /** 마지막으로 기록에 넣은 메시지 uuid. 처음엔 null. */
  cursor: string | null;
  /** 현재 구간의 연속 실패 횟수. */
  failures: number;
  lastSeenAt: string;
  lastReadAt: string | null;
  /** 등록 시각으로 시작해 기록에 성공할 때마다 기록 시각. 구간 시간대의 시작이다. */
  recordedUntil: string;
}

export interface MemoryFile {
  version: 1;
  experiences: Experience[];
  sessions: TrackedSession[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isImportance(value: unknown): value is Importance {
  return value === 1 || value === 2 || value === 3;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function emptyMemoryFile(): MemoryFile {
  return { version: 1, experiences: [], sessions: [] };
}

function parseExperience(value: unknown): Experience | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { id, summary, feeling, importance, at, sessionId, moodReasons, moodDelta } = value;
  if (
    typeof id !== "string" ||
    typeof summary !== "string" ||
    summary.trim() === "" ||
    typeof feeling !== "string" ||
    !isImportance(importance) ||
    !isTimestamp(at) ||
    typeof sessionId !== "string" ||
    !isStringArray(moodReasons) ||
    !isRecord(moodDelta) ||
    !isFiniteNumber(moodDelta.stress) ||
    !isFiniteNumber(moodDelta.dopamine)
  ) {
    return undefined;
  }
  return {
    id,
    summary: sliceChars(summary, SUMMARY_MAX),
    feeling: sliceChars(feeling, FEELING_MAX),
    importance,
    at,
    sessionId,
    moodReasons,
    moodDelta: { stress: moodDelta.stress, dopamine: moodDelta.dopamine },
  };
}

function parseSession(value: unknown): TrackedSession | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { sessionId, cwd, cursor, failures, lastSeenAt, lastReadAt, recordedUntil } = value;
  if (
    typeof sessionId !== "string" ||
    typeof cwd !== "string" ||
    (cursor !== null && typeof cursor !== "string") ||
    !isFiniteNumber(failures) ||
    !isTimestamp(lastSeenAt) ||
    (lastReadAt !== null && !isTimestamp(lastReadAt)) ||
    !isTimestamp(recordedUntil)
  ) {
    return undefined;
  }
  return { sessionId, cwd, cursor, failures, lastSeenAt, lastReadAt, recordedUntil };
}

/** 최상위 형식이 틀리면 undefined. 항목 하나가 깨졌으면 그 항목만 버린다. 긴 summary·feeling은 자른다. */
export function parseMemoryFile(value: unknown): MemoryFile | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.experiences) || !Array.isArray(value.sessions)) {
    return undefined;
  }
  return {
    version: 1,
    experiences: value.experiences.flatMap((item) => parseExperience(item) ?? []),
    sessions: value.sessions.flatMap((item) => parseSession(item) ?? []),
  };
}

function byTimeAscending(a: Experience, b: Experience): number {
  return Date.parse(a.at) - Date.parse(b.at);
}

/** 중요도 낮은 것 → 같은 중요도면 at이 오래된 것부터 지워 limit개 이하로. 남은 것은 at 오름차순. */
export function pruneExperiences(experiences: readonly Experience[], limit: number = MEMORY_LIMIT): Experience[] {
  const keepOrder = [...experiences].sort((a, b) => b.importance - a.importance || Date.parse(b.at) - Date.parse(a.at));
  return keepOrder.slice(0, limit).sort(byTimeAscending);
}

/** lastReadAt(없으면 lastSeenAt)이 SESSION_STALE_DAYS를 넘은 세션을 빼고, lastSeenAt 최근 순 MEMORY_SESSION_LIMIT개. */
export function trimSessions(sessions: readonly TrackedSession[], now: Date): TrackedSession[] {
  const staleBefore = now.getTime() - SESSION_STALE_DAYS * DAY_MS;
  return sessions
    .filter((session) => Date.parse(session.lastReadAt ?? session.lastSeenAt) >= staleBefore)
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
    .slice(0, MEMORY_SESSION_LIMIT);
}

/**
 * 다른 프로세스가 그사이 쓴 파일(onDisk)과 내 상태(mine)를 합친다.
 * 경험은 id 합집합(같은 id는 mine) 후 pruneExperiences.
 * 세션은 sessionId 합집합이고, 양쪽에 있으면 recordedUntil이 늦은 쪽 항목 전체를 쓴다(같으면 mine).
 * 합집합이라 파일이 끝없이 커지지 않도록 세션은 최근 lastSeenAt 순 MEMORY_SESSION_LIMIT개만 남긴다.
 * 커서 uuid만으로는 어느 쪽이 더 뒤인지 알 수 없어서 recordedUntil로 판단한다.
 */
export function mergeMemoryFiles(onDisk: MemoryFile, mine: MemoryFile): MemoryFile {
  const experiences = new Map(onDisk.experiences.map((item) => [item.id, item]));
  for (const item of mine.experiences) {
    experiences.set(item.id, item);
  }
  const sessions = new Map(onDisk.sessions.map((item) => [item.sessionId, item]));
  for (const item of mine.sessions) {
    const disk = sessions.get(item.sessionId);
    if (disk === undefined || Date.parse(item.recordedUntil) >= Date.parse(disk.recordedUntil)) {
      sessions.set(item.sessionId, item);
    }
  }
  const recentSessions = [...sessions.values()]
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
    .slice(0, MEMORY_SESSION_LIMIT);
  return { version: 1, experiences: pruneExperiences([...experiences.values()]), sessions: recentSessions };
}

export interface StartupMemories {
  memories: Experience[];
  /** 첫 대화에서 먼저 언급해도 되는 기억. 가장 최근 세션의 중요도 3 중 가장 최근 것. */
  lead?: Experience;
}

function latestFirst(a: Experience, b: Experience): number {
  return Date.parse(b.at) - Date.parse(a.at);
}

/** 중요도 내림차순 → 최근 순 STARTUP_MEMORIES개와, 가장 최근 세션의 중요도 3 기억(lead). */
export function selectStartupMemories(experiences: readonly Experience[]): StartupMemories {
  const memories = [...experiences]
    .sort((a, b) => b.importance - a.importance || latestFirst(a, b))
    .slice(0, STARTUP_MEMORIES);
  const latestSessionId = [...experiences].sort(latestFirst)[0]?.sessionId;
  const lead = [...experiences]
    .sort(latestFirst)
    .find((item) => item.sessionId === latestSessionId && item.importance === 3);
  return lead === undefined ? { memories } : { memories, lead };
}

export interface RecallInput {
  prompt: string;
  experiences: readonly Experience[];
  excludeIds: ReadonlySet<string>;
  /** 경험 id → 마지막으로 떠올린 턴 번호. */
  lastRecalledTurn: ReadonlyMap<string, number>;
  turn: number;
}

/**
 * 입력과 관련 있는 기억을 유사도 순으로 RECALL_MAX개 고른다.
 * 정규화(행동 줄 제거 포함)한 입력이 RECALL_MIN_CHARS보다 짧으면 고르지 않는다.
 */
export function recallMemories(input: RecallInput): Experience[] {
  const prompt = normalizePrompt(input.prompt);
  if ([...prompt].length < RECALL_MIN_CHARS) {
    return [];
  }
  const isCoolingDown = (id: string): boolean => {
    const last = input.lastRecalledTurn.get(id);
    return last !== undefined && input.turn - last < RECALL_COOLDOWN_TURNS;
  };
  return input.experiences
    .filter((item) => !input.excludeIds.has(item.id) && !isCoolingDown(item.id))
    .map((item) => ({ item, similarity: bigramSimilarity(prompt, normalizePrompt(item.summary)) }))
    .filter(({ similarity }) => similarity >= RECALL_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, RECALL_MAX)
    .map(({ item }) => item);
}

/** 기록할 때의 기분 변화 방향(부호)에 중요도별 크기를 곱한다. 두 축 모두 0이면 이벤트 없음. */
export function recallEvent(experience: Experience): MoodEvent | undefined {
  const size = RECALL_DELTAS[experience.importance];
  const stress = Math.sign(experience.moodDelta.stress) * size;
  const dopamine = Math.sign(experience.moodDelta.dopamine) * size;
  if (stress === 0 && dopamine === 0) {
    return undefined;
  }
  return { kind: "recall", summary: experience.summary, stress, dopamine };
}

/** 런타임이 메모리에 두는 기분 표시점(극단 진입·탈출, 부호 전환). */
export interface MoodMarker {
  at: string;
  text: string;
}

export interface SegmentMood {
  moodReasons: string[];
  moodDelta: { stress: number; dopamine: number };
  /** 구간 시간대의 표시점. 기록 프롬프트에서 "강한 후보"가 된다. */
  strongHints: string[];
}

/** from < at ≤ to 인 이유와 표시점만 모은다. 이유 문구는 중복 없이 순서대로, 변화량은 합계를 반올림한다. */
export function summarizeSegmentMood(
  reasons: readonly MoodReason[],
  markers: readonly MoodMarker[],
  from: string,
  to: string,
): SegmentMood {
  const start = Date.parse(from);
  const end = Date.parse(to);
  const inRange = (at: string): boolean => {
    const time = Date.parse(at);
    return time > start && time <= end;
  };
  const picked = reasons.filter((reason) => inRange(reason.at));
  const sum = (key: "stress" | "dopamine"): number =>
    Math.round(picked.reduce((total, reason) => total + reason[key], 0));
  return {
    moodReasons: [...new Set(picked.map((reason) => reason.text))],
    moodDelta: { stress: sum("stress"), dopamine: sum("dopamine") },
    strongHints: markers.filter((marker) => inRange(marker.at)).map((marker) => marker.text),
  };
}
