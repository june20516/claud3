import { styleText } from "node:util";

type TextFormat = Parameters<typeof styleText>[0];

// 출력 대상 스트림 검사를 끄고 항상 ANSI 코드를 붙인다(화면 계층이 색 사용 여부를 정한다).
function paint(format: TextFormat, text: string): string {
  return styleText(format, text, { validateStream: false });
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
const INLINE_CODE_PATTERN = /(`[^`]+`)/;
const BOLD_PATTERN = /\*\*([^*]+)\*\*/g;
const LINK_PATTERN = /\[([^\]]+)\]\(([^)\s]+)\)/g;

function renderPlainSegment(segment: string): string {
  return segment
    .replace(BOLD_PATTERN, (_match, text: string) => paint("bold", text))
    .replace(LINK_PATTERN, (_match, text: string, url: string) => `${text}${paint("dim", ` (${url})`)}`);
}

function renderInline(text: string): string {
  return text
    .split(INLINE_CODE_PATTERN)
    .map((segment) =>
      segment.length > 2 && segment.startsWith("`") && segment.endsWith("`")
        ? paint("cyan", segment.slice(1, -1))
        : renderPlainSegment(segment),
    )
    .join("");
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
