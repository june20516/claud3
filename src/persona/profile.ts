import { REACTION_LIMIT } from "./tuning.js";

export type Direction = "hot" | "cold" | "elated" | "sunken";
export const DIRECTIONS: readonly Direction[] = ["hot", "cold", "elated", "sunken"];

export interface MoodExample {
  line: string;
  action: string;
}

export interface DirectionStyle {
  tendency: string;
  examples: MoodExample[];
}

export interface PersonaReaction {
  keywords: string[];
  stress: number;
  dopamine: number;
  note: string;
}

/** days는 0(일)~6(토), start·end는 "HH:MM". */
export interface WorkHours {
  days: number[];
  start: string;
  end: string;
}

export type PersonaDirections = { calm: { normal: DirectionStyle } } & Record<
  Direction,
  { normal: DirectionStyle; extreme: DirectionStyle }
>;

export interface PersonaProfile {
  version: 1;
  name: string;
  displayName: string;
  summary: string;
  relationship: string;
  speechLevel: "polite" | "casual";
  speechExamples: string[];
  catchphrases: string[];
  avoid: string[];
  sensitivity: { stress: number; dopamine: number };
  workHours: WorkHours | null;
  directions: PersonaDirections;
  reactions: PersonaReaction[];
  sources: string[];
  createdAt: string;
}

/** 조사·설문 중간 결과. 형식이 맞는 필드만 담는다. */
export type PersonaDraft = Partial<Omit<PersonaProfile, "version" | "name" | "createdAt">>;

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ProfileValidation = { ok: true; profile: PersonaProfile } | { ok: false; issues: ValidationIssue[] };

const PERSONA_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidPersonaName(name: string): boolean {
  return PERSONA_NAME_PATTERN.test(name);
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 필드 검사 결과를 모으는 도우미. 각 check는 문제가 있으면 issue를 남긴다. */
class IssueCollector {
  readonly issues: ValidationIssue[] = [];

  add(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  string(record: UnknownRecord, key: string, path: string): void {
    if (typeof record[key] !== "string") {
      this.add(path, "문자열이어야 합니다");
    }
  }

  stringArray(record: UnknownRecord, key: string, path: string): void {
    if (!isStringArray(record[key])) {
      this.add(path, "문자열 배열이어야 합니다");
    }
  }
}

function checkSensitivity(value: unknown, issues: IssueCollector): void {
  if (!isRecord(value)) {
    issues.add("sensitivity", "객체여야 합니다");
    return;
  }
  for (const key of ["stress", "dopamine"]) {
    if (!isIntegerIn(value[key], 1, 5)) {
      issues.add(`sensitivity.${key}`, "1~5 정수여야 합니다");
    }
  }
}

function checkWorkHours(value: unknown, issues: IssueCollector): void {
  if (value === null) {
    return;
  }
  if (!isRecord(value)) {
    issues.add("workHours", "객체 또는 null이어야 합니다");
    return;
  }
  const { days, start, end } = value;
  if (!Array.isArray(days) || days.length === 0 || !days.every((day) => isIntegerIn(day, 0, 6))) {
    issues.add("workHours.days", "0(일)~6(토) 정수 배열이어야 합니다");
  }
  for (const [key, time] of [["start", start], ["end", end]] as const) {
    if (typeof time !== "string" || !TIME_PATTERN.test(time)) {
      issues.add(`workHours.${key}`, "HH:MM 형식이어야 합니다");
    }
  }
}

function checkDirectionStyle(value: unknown, path: string, issues: IssueCollector): void {
  if (!isRecord(value)) {
    issues.add(path, "필수 항목입니다");
    return;
  }
  issues.string(value, "tendency", `${path}.tendency`);
  const { examples } = value;
  const validExamples =
    Array.isArray(examples) &&
    examples.every((example) => isRecord(example) && typeof example.line === "string" && typeof example.action === "string");
  if (!validExamples) {
    issues.add(`${path}.examples`, "{ line, action } 배열이어야 합니다");
  }
}

function checkDirections(value: unknown, issues: IssueCollector): void {
  if (!isRecord(value)) {
    issues.add("directions", "객체여야 합니다");
    return;
  }
  const calm = value.calm;
  checkDirectionStyle(isRecord(calm) ? calm.normal : undefined, "directions.calm.normal", issues);
  for (const direction of ["hot", "cold", "elated", "sunken"]) {
    const entry = value[direction];
    if (!isRecord(entry)) {
      issues.add(`directions.${direction}`, "필수 항목입니다");
      continue;
    }
    checkDirectionStyle(entry.normal, `directions.${direction}.normal`, issues);
    checkDirectionStyle(entry.extreme, `directions.${direction}.extreme`, issues);
  }
}

function checkReactions(value: unknown, issues: IssueCollector): void {
  if (!Array.isArray(value)) {
    issues.add("reactions", "배열이어야 합니다");
    return;
  }
  value.forEach((reaction: unknown, index) => {
    const path = `reactions[${index}]`;
    if (!isRecord(reaction)) {
      issues.add(path, "객체여야 합니다");
      return;
    }
    if (!isStringArray(reaction.keywords) || reaction.keywords.length === 0) {
      issues.add(`${path}.keywords`, "비어 있지 않은 문자열 배열이어야 합니다");
    }
    for (const key of ["stress", "dopamine"]) {
      if (!isIntegerIn(reaction[key], -REACTION_LIMIT, REACTION_LIMIT)) {
        issues.add(`${path}.${key}`, `−${REACTION_LIMIT}~${REACTION_LIMIT} 정수여야 합니다`);
      }
    }
    issues.string(reaction, "note", `${path}.note`);
  });
}

export function validateProfile(value: unknown): ProfileValidation {
  if (!isRecord(value)) {
    return { ok: false, issues: [{ path: "", message: "객체여야 합니다" }] };
  }
  const issues = new IssueCollector();
  if (value.version !== 1) {
    issues.add("version", "1이어야 합니다");
  }
  if (typeof value.name !== "string" || !isValidPersonaName(value.name)) {
    issues.add("name", "소문자·숫자·_·- 1~32자여야 합니다");
  }
  for (const key of ["displayName", "summary", "relationship", "createdAt"]) {
    issues.string(value, key, key);
  }
  if (value.speechLevel !== "polite" && value.speechLevel !== "casual") {
    issues.add("speechLevel", '"polite" 또는 "casual"이어야 합니다');
  }
  for (const key of ["speechExamples", "catchphrases", "avoid", "sources"]) {
    issues.stringArray(value, key, key);
  }
  checkSensitivity(value.sensitivity, issues);
  checkWorkHours(value.workHours, issues);
  checkDirections(value.directions, issues);
  checkReactions(value.reactions, issues);

  if (issues.issues.length > 0) {
    return { ok: false, issues: issues.issues };
  }
  // 위 검사로 모든 필드의 형식을 확인했다.
  return { ok: true, profile: value as unknown as PersonaProfile };
}

/** 필드 하나를 따로 검사해 문제가 없는지 본다. */
function isFieldValid(check: (issues: IssueCollector) => void): boolean {
  const issues = new IssueCollector();
  check(issues);
  return issues.issues.length === 0;
}

const DRAFT_FIELD_CHECKS: Record<keyof PersonaDraft, (value: unknown, issues: IssueCollector) => void> = {
  displayName: (value, issues) => issues.string({ value }, "value", "displayName"),
  summary: (value, issues) => issues.string({ value }, "value", "summary"),
  relationship: (value, issues) => issues.string({ value }, "value", "relationship"),
  speechLevel: (value, issues) => {
    if (value !== "polite" && value !== "casual") {
      issues.add("speechLevel", "형식 오류");
    }
  },
  speechExamples: (value, issues) => issues.stringArray({ value }, "value", "speechExamples"),
  catchphrases: (value, issues) => issues.stringArray({ value }, "value", "catchphrases"),
  avoid: (value, issues) => issues.stringArray({ value }, "value", "avoid"),
  sources: (value, issues) => issues.stringArray({ value }, "value", "sources"),
  sensitivity: checkSensitivity,
  workHours: checkWorkHours,
  directions: checkDirections,
  reactions: checkReactions,
};

/** 조사 결과처럼 믿을 수 없는 값에서 형식이 맞는 최상위 필드만 남긴다. */
export function parseDraft(value: unknown): PersonaDraft {
  if (!isRecord(value)) {
    return {};
  }
  const draft: UnknownRecord = {};
  for (const [key, check] of Object.entries(DRAFT_FIELD_CHECKS)) {
    if (key in value && isFieldValid((issues) => check(value[key], issues))) {
      draft[key] = value[key];
    }
  }
  // 각 필드를 PersonaProfile과 같은 검사로 확인한 것만 담았다.
  return draft as PersonaDraft;
}
