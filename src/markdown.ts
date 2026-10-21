import { styleText } from "node:util";

type TextFormat = Parameters<typeof styleText>[0];

// 기본 styleText 동작을 따른다(파이프·NO_COLOR 환경에서는 색을 끈다).
function paint(format: TextFormat, text: string): string {
  return styleText(format, text);
}

export interface MarkdownStreamRenderer {
  /** 완성된 줄만 렌더링해 돌려주고, 줄바꿈 없는 마지막 조각은 보관한다. */
  push(text: string): string;
  /** 보관 중인 조각을 렌더링해 돌려주고 코드 블록 상태를 초기화한다. */
  flush(): string;
}

export interface MarkdownLineState {
  inCodeBlock: boolean;
}

const CODE_FENCE = "```";
const HEADING_PATTERN = /^(#{1,6}) +(.*)$/;
const LIST_PATTERN = /^(\s*)[-*+] (.*)$/;
const QUOTE_PATTERN = /^> ?(.*)$/;
const INLINE_CODE_PATTERN = /`([^`]+)`/g;
const BOLD_PATTERN = /\*\*([^*]+)\*\*/g;
const LINK_PATTERN = /\[([^\]]+)\]\(([^)\s]+)\)/g;
// 인라인 코드를 잠시 바꿔 둘 자리표시자. 일반 텍스트에 나오지 않는 NUL 문자로 감싼다.
const CODE_PLACEHOLDER_PATTERN = /\0(\d+)\0/g;

/**
 * 인라인 코드를 자리표시자로 보호한 채 굵게·링크를 줄 전체에 적용한 뒤 코드를 되돌린다.
 * 그래야 `**`가 코드 앞뒤로 갈라져 있어도(`**\`a.ts\` 파일**`) 짝을 찾고, 코드 안의 `**`는 건드리지 않는다.
 */
function renderInline(text: string): string {
  const codeSpans: string[] = [];
  const protectedText = text.replace(INLINE_CODE_PATTERN, (_match, code: string) => {
    codeSpans.push(code);
    return `\0${codeSpans.length - 1}\0`;
  });

  return protectedText
    .replace(BOLD_PATTERN, (_match, content: string) => paint("bold", content))
    .replace(LINK_PATTERN, (_match, label: string, url: string) => `${label}${paint("dim", ` (${url})`)}`)
    .replace(CODE_PLACEHOLDER_PATTERN, (_match, index: string) => paint("cyan", codeSpans[Number(index)] ?? ""));
}

export function renderMarkdownLine(line: string, state: MarkdownLineState): string {
  if (line.trimStart().startsWith(CODE_FENCE)) {
    state.inCodeBlock = !state.inCodeBlock;
    return paint("dim", line);
  }
  if (state.inCodeBlock) {
    return paint("cyan", line);
  }

  const heading = HEADING_PATTERN.exec(line);
  if (heading) {
    const [, marks = "", title = ""] = heading;
    return paint(marks.length === 1 ? ["bold", "underline"] : "bold", title);
  }

  const quote = QUOTE_PATTERN.exec(line);
  if (quote) {
    return paint("dim", `│ ${quote[1] ?? ""}`);
  }

  const listItem = LIST_PATTERN.exec(line);
  if (listItem) {
    const [, indent = "", content = ""] = listItem;
    return `${indent}• ${renderInline(content)}`;
  }

  return renderInline(line);
}

export function createMarkdownRenderer(): MarkdownStreamRenderer {
  const state: MarkdownLineState = { inCodeBlock: false };
  let pending = "";

  return {
    push(text) {
      const lines = (pending + text).split("\n");
      pending = lines.pop() ?? "";
      return lines.map((line) => `${renderMarkdownLine(line, state)}\n`).join("");
    },
    flush() {
      const rendered = pending === "" ? "" : renderMarkdownLine(pending, state);
      pending = "";
      state.inCodeBlock = false;
      return rendered;
    },
  };
}
