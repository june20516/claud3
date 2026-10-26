import type { UserQuestion, UserQuestionAnswers } from "./types.js";

export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

/** 복수 선택한 label을 잇는 구분자 (SDK 문서의 형식). */
const LABEL_SEPARATOR = ", ";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOption(value: unknown): UserQuestion["options"][number] | undefined {
  if (!isRecord(value) || typeof value.label !== "string") {
    return undefined;
  }
  return { label: value.label, description: typeof value.description === "string" ? value.description : "" };
}

function parseQuestion(value: unknown): UserQuestion | undefined {
  if (!isRecord(value) || typeof value.question !== "string" || !Array.isArray(value.options)) {
    return undefined;
  }
  const options = value.options.map(parseOption);
  if (options.length === 0 || options.some((option) => option === undefined)) {
    return undefined;
  }
  return {
    question: value.question,
    header: typeof value.header === "string" ? value.header : "",
    options: options.filter((option) => option !== undefined),
    multiSelect: value.multiSelect === true,
  };
}

/** AskUserQuestion 도구 입력에서 질문 목록을 읽는다. 형식이 맞지 않으면 undefined. */
export function parseUserQuestions(input: Record<string, unknown>): UserQuestion[] | undefined {
  const { questions } = input;
  if (!Array.isArray(questions) || questions.length === 0) {
    return undefined;
  }
  const parsed = questions.map(parseQuestion);
  return parsed.some((question) => question === undefined)
    ? undefined
    : parsed.filter((question) => question !== undefined);
}

export function joinLabels(labels: readonly string[]): string {
  return labels.join(LABEL_SEPARATOR);
}

/** 쉼표로 나눈 번호가 모두 선택지 범위 안이면 그 label들. 아니면 undefined. */
function labelsOfNumbers(text: string, question: UserQuestion): string[] | undefined {
  const parts = text.split(",").map((part) => part.trim());
  if (!parts.every((part) => /^\d+$/.test(part))) {
    return undefined;
  }
  const labels = parts.map((part) => question.options[Number(part) - 1]?.label);
  if (labels.some((label) => label === undefined)) {
    return undefined;
  }
  if (!question.multiSelect && labels.length !== 1) {
    return undefined;
  }
  return labels.filter((label) => label !== undefined);
}

/** 번호(복수 선택이면 쉼표로 여러 개)는 label로 바꾸고, 그 밖의 글은 직접 쓴 답으로 쓴다. 빈 답은 undefined. */
export function parseQuestionAnswer(text: string, question: UserQuestion): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  const labels = labelsOfNumbers(trimmed, question);
  return labels === undefined ? trimmed : joinLabels(labels);
}

/** 질문 머리줄. 질문이 여럿이면 순서를 붙인다. */
export function formatQuestionTitle(question: UserQuestion, index: number, total: number): string {
  const position = total > 1 ? `${index + 1}/${total}` : "";
  const tag = [position, question.header].filter((part) => part !== "").join(" ");
  return tag === "" ? question.question : `[${tag}] ${question.question}`;
}

export function formatOption(option: UserQuestion["options"][number]): string {
  return option.description === "" ? option.label : `${option.label} — ${option.description}`;
}

/** plain 화면에 보일 질문. 번호 붙은 선택지와 입력 안내를 붙인다. */
export function formatQuestionPrompt(question: UserQuestion, index: number, total: number): string {
  const guide = question.multiSelect
    ? "번호(여러 개는 쉼표로)나 직접 쓴 답을 입력하세요"
    : "번호나 직접 쓴 답을 입력하세요";
  return [
    formatQuestionTitle(question, index, total),
    ...question.options.map((option, optionIndex) => `  ${optionIndex + 1}. ${formatOption(option)}`),
    guide,
  ].join("\n");
}

/** 답한 뒤 대화 영역에 남길 요약. 질문마다 `header: 답` 한 줄. */
export function formatAnswerSummary(questions: readonly UserQuestion[], answers: UserQuestionAnswers): string {
  return questions
    .map((question) => `${question.header === "" ? question.question : question.header}: ${answers[question.question] ?? ""}`)
    .join("\n");
}
