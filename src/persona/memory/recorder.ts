import type { Options, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MoodReason } from "../mood.js";
import { OneShotQueryError, runStructuredQuery } from "../oneShot.js";
import type { OneShotQueryFn, OneShotResult } from "../oneShot.js";
import type { PersonaProfile } from "../profile.js";
import {
  RECENT_SUMMARIES_FOR_RECORD,
  RECORD_BUDGET_USD,
  RECORD_MAX_FAILURES,
  RECORD_TIMEOUT_MS,
} from "../tuning.js";
import { mergeMemoryFiles, pruneExperiences, summarizeSegmentMood, trimSessions } from "./experience.js";
import type { Experience, MemoryFile, MoodMarker, TrackedSession } from "./experience.js";
import { buildRecordPrompt, parseRecordOutput, RECORD_SCHEMA } from "./recordPrompt.js";
import type { RecordedItem } from "./recordPrompt.js";
import { buildSegment } from "./segment.js";

const RECORD_MODEL = "claude-haiku-5-5";
/** 구조화 출력은 내부 도구 호출로 끝나므로 1턴으로는 모자랄 수 있다(반응 판단기와 같다). */
const RECORD_MAX_TURNS = 3;

export type RecordModel = (prompt: string) => Promise<OneShotResult>;

/** 도구 없이, 사용자 설정(hook·플러그인)과 격리한 Haiku 호출. RECORD_TIMEOUT_MS가 지나면 중단한다. */
export function createRecordModel(queryFn: OneShotQueryFn, env: Record<string, string | undefined>): RecordModel {
  return async (prompt) => {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), RECORD_TIMEOUT_MS);
    const options: Options = {
      model: RECORD_MODEL,
      tools: [],
      settingSources: [],
      // one-shot 세션이 /resume 목록과 따라잡기 대상에 남지 않게 한다.
      persistSession: false,
      maxTurns: RECORD_MAX_TURNS,
      maxBudgetUsd: RECORD_BUDGET_USD,
      env,
      abortController,
      outputFormat: { type: "json_schema", schema: RECORD_SCHEMA },
    };
    try {
      return await runStructuredQuery(queryFn, prompt, options);
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface MemoryRecorderDeps {
  profile: PersonaProfile;
  initialFile: MemoryFile;
  readMessages: (sessionId: string, cwd: string) => Promise<SessionMessage[]>;
  model: RecordModel;
  /** 디스크와 합쳐 저장하고 합친 결과를 돌려준다. */
  save: (file: MemoryFile) => Promise<MemoryFile>;
  moodContext: () => { reasons: readonly MoodReason[]; markers: readonly MoodMarker[] };
  clock: () => Date;
  onCost: (usd: number) => void;
  onWarning: (message: string) => void;
  onChange: (file: MemoryFile) => void;
}

export interface MemoryRecorder {
  /** 처음 보는 세션이면 커서 null로 추가하고, 아는 세션이면 lastSeenAt만 갱신한다. 저장은 대기열에서 한다. */
  register(sessionId: string, cwd: string): void;
  /** 그 세션 기록을 대기열에 넣고 끝나면 resolve한다. 절대 reject하지 않는다. 등록 안 된 세션은 아무것도 하지 않는다. */
  request(sessionId: string): Promise<void>;
  /** 오래 못 읽은 세션을 정리하고, 남은 세션을 차례로 기록한다. */
  catchUp(): Promise<void>;
  current(): MemoryFile;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function updateSession(file: MemoryFile, sessionId: string, change: Partial<TrackedSession>): MemoryFile {
  return {
    ...file,
    sessions: file.sessions.map((item) => (item.sessionId === sessionId ? { ...item, ...change } : item)),
  };
}

function recentSummaries(experiences: readonly Experience[]): string[] {
  return [...experiences]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, RECENT_SUMMARIES_FOR_RECORD)
    .map((item) => item.summary);
}

/**
 * 대화 구간을 읽어 인격이 기억할 일을 기록한다(spec 4.2). 기록은 전체에서 한 번에 하나씩 돈다.
 * 실패는 삼키고 경고는 실행당 한 번만 한다. 기억 내용은 화면에 내지 않는다.
 */
export function createMemoryRecorder(deps: MemoryRecorderDeps): MemoryRecorder {
  let file = deps.initialFile;
  let warned = false;
  let chain: Promise<void> = Promise.resolve();
  /** 아직 시작하지 않은 세션별 요청. 같은 세션 요청은 여기서 합쳐진다. */
  const queued = new Map<string, Promise<void>>();

  function warn(error: unknown): void {
    if (!warned) {
      warned = true;
      deps.onWarning(`인격 기억을 기록하지 못했습니다: ${errorText(error)}`);
    }
  }

  function enqueue(task: () => Promise<void>): Promise<void> {
    const run = chain.then(task).catch(warn);
    chain = run;
    return run;
  }

  /** update를 적용해 저장한다. 실패하면 메모리 상태를 바꾸지 않는다. 저장 대기 중 등록된 세션은 합쳐서 지킨다. */
  async function commit(update: (current: MemoryFile) => MemoryFile): Promise<void> {
    try {
      const saved = await deps.save(update(file));
      // 저장 결과가 이기고(같은 시각이어도), 저장하는 동안 메모리에만 생긴 세션은 남긴다.
      file = mergeMemoryFiles(file, saved);
      deps.onChange(file);
    } catch (error) {
      warn(error);
    }
  }

  function addExperiences(current: MemoryFile, session: TrackedSession, items: RecordedItem[], now: string): MemoryFile {
    const mood = summarizeSegmentMood(deps.moodContext().reasons, [], session.recordedUntil, now);
    const added = items.map(
      (item, index): Experience => ({
        id: `${now}-${index}`,
        ...item,
        at: now,
        sessionId: session.sessionId,
        moodReasons: mood.moodReasons,
        moodDelta: mood.moodDelta,
      }),
    );
    return { ...current, experiences: pruneExperiences([...current.experiences, ...added]) };
  }

  async function recordOnce(sessionId: string): Promise<void> {
    const session = file.sessions.find((item) => item.sessionId === sessionId);
    if (session === undefined) {
      return;
    }
    const now = deps.clock().toISOString();
    let messages: SessionMessage[];
    try {
      messages = await deps.readMessages(sessionId, session.cwd);
    } catch (error) {
      warn(error);
      return;
    }
    const segment = buildSegment(messages, session.cursor, deps.profile.displayName);
    if (segment === undefined || segment.userInputs === 0) {
      await commit((current) => updateSession(current, sessionId, { lastReadAt: now }));
      return;
    }
    const { reasons, markers } = deps.moodContext();
    const prompt = buildRecordPrompt({
      profile: deps.profile,
      segment,
      mood: summarizeSegmentMood(reasons, markers, session.recordedUntil, now),
      recentSummaries: recentSummaries(file.experiences),
    });
    let items: RecordedItem[] | undefined;
    try {
      const result = await deps.model(prompt);
      deps.onCost(result.costUsd);
      items = parseRecordOutput(result.output);
      if (items === undefined) {
        warn(new Error("기록 결과 형식이 맞지 않습니다"));
      }
    } catch (error) {
      if (error instanceof OneShotQueryError) {
        deps.onCost(error.costUsd);
      }
      warn(error);
    }
    if (items === undefined) {
      const failures = session.failures + 1;
      // 같은 구간이 계속 실패하면 비용이 끝없이 나가므로 넘긴다.
      const change: Partial<TrackedSession> =
        failures >= RECORD_MAX_FAILURES
          ? { cursor: segment.lastUuid, failures: 0, recordedUntil: now, lastReadAt: now }
          : { failures, lastReadAt: now };
      await commit((current) => updateSession(current, sessionId, change));
      return;
    }
    const recorded = items;
    await commit((current) =>
      updateSession(addExperiences(current, session, recorded, now), sessionId, {
        cursor: segment.lastUuid,
        failures: 0,
        recordedUntil: now,
        lastReadAt: now,
      }),
    );
  }

  function request(sessionId: string): Promise<void> {
    const waiting = queued.get(sessionId);
    if (waiting !== undefined) {
      return waiting;
    }
    const run = enqueue(async () => {
      queued.delete(sessionId);
      await recordOnce(sessionId);
    });
    queued.set(sessionId, run);
    return run;
  }

  return {
    register(sessionId, cwd) {
      const now = deps.clock().toISOString();
      const known = file.sessions.some((item) => item.sessionId === sessionId);
      file = known
        ? updateSession(file, sessionId, { lastSeenAt: now, cwd })
        : {
            ...file,
            sessions: [
              ...file.sessions,
              { sessionId, cwd, cursor: null, failures: 0, lastSeenAt: now, lastReadAt: null, recordedUntil: now },
            ],
          };
      void enqueue(() => commit((current) => current));
    },
    request,
    async catchUp() {
      const trimmed = trimSessions(file.sessions, deps.clock());
      file = { ...file, sessions: trimmed };
      await enqueue(() => commit((current) => current));
      await Promise.all(trimmed.map((item) => request(item.sessionId)));
    },
    current: () => file,
  };
}
