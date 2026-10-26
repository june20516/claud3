import { Box, Text, useCursor, useInput, usePaste, useStdout } from "ink";
import { useReducer, useRef } from "react";
import stringWidth from "string-width";
import { HISTORY_SIZE } from "../../inputHistory.js";
import { MultilineBuffer } from "../plain.js";
import { columnsOf } from "./terminalSize.js";

const PROMPT = "> ";
const CONTINUATION_PROMPT = "… ";

export interface InputBoxProps {
  /** false면 키를 받지 않고 커서도 그리지 않는다(대화상자가 떠 있을 때). */
  isActive: boolean;
  /** 첫 항목이 가장 최근 입력. */
  initialHistory: readonly string[];
  onSubmit: (text: string) => void;
  /** 여러 줄 입력 중이 아닐 때 Ctrl+C. */
  onInterrupt: () => void;
  onHistoryChange?: (history: string[]) => void;
  /** 입력이 비어 있을 때 Ctrl+D. */
  onExit?: () => void;
  /**
   * Ink 동적 출력 맨 위에서 센 입력창 첫 행. 알면 터미널의 실제 커서를 커서 칸에 둔다.
   * 한글 IME는 조합 중인 글자를 실제 커서 자리에 그리기 때문이다.
   */
  originRow?: number;
}

/** 입력 중인 줄. 전각 문자·이모지가 한 칸씩 움직이도록 코드 포인트 배열로 다룬다. */
interface EditLine {
  chars: string[];
  cursor: number;
}

const EMPTY_LINE: EditLine = { chars: [], cursor: 0 };

function lineOf(text: string): EditLine {
  const chars = Array.from(text);
  return { chars, cursor: chars.length };
}

/** 터미널은 줄바꿈을 \r로 보내므로 \r\n·\r·\n 어느 것이든 줄 경계로 본다. */
const LINE_BREAK = /\r\n|\r|\n/;

function insertText(line: EditLine, text: string): EditLine {
  const inserted = Array.from(text);
  return {
    chars: [...line.chars.slice(0, line.cursor), ...inserted, ...line.chars.slice(line.cursor)],
    cursor: line.cursor + inserted.length,
  };
}

function deleteBackward(line: EditLine): EditLine {
  if (line.cursor === 0) {
    return line;
  }
  return {
    chars: [...line.chars.slice(0, line.cursor - 1), ...line.chars.slice(line.cursor)],
    cursor: line.cursor - 1,
  };
}

function deleteForward(line: EditLine): EditLine {
  return { chars: [...line.chars.slice(0, line.cursor), ...line.chars.slice(line.cursor + 1)], cursor: line.cursor };
}

function moveCursor(line: EditLine, cursor: number): EditLine {
  return { ...line, cursor: Math.min(Math.max(cursor, 0), line.chars.length) };
}

function promptOf(lineIndex: number): string {
  return lineIndex === 0 ? PROMPT : CONTINUATION_PROMPT;
}

/** 표시 폭이 width인 줄이 columns칸 터미널에서 차지하는 행 수. */
function rowsOf(width: number, columns: number): number {
  return Math.max(1, Math.ceil(width / columns));
}

/** 입력창 맨 위 행·첫 칸을 기준으로 한 커서 칸. 전각 문자 폭과 터미널 폭에서 감기는 행을 센다. */
export function inputCursorOffset({
  collectedLines,
  textBeforeCursor,
  columns,
}: {
  collectedLines: readonly string[];
  textBeforeCursor: string;
  columns: number;
}): { x: number; y: number } {
  const width = Math.max(columns, 1);
  let row = 0;
  collectedLines.forEach((collected, index) => {
    row += rowsOf(stringWidth(promptOf(index) + collected), width);
  });
  // 붙여넣은 줄바꿈 뒤의 줄은 프롬프트 없이 첫 칸부터 그려진다.
  const segments = textBeforeCursor.split("\n");
  const prompt = promptOf(collectedLines.length);
  const lastSegment = segments.pop() ?? "";
  segments.forEach((segment, index) => {
    row += rowsOf(stringWidth((index === 0 ? prompt : "") + segment), width);
  });
  const lastWidth = stringWidth((segments.length === 0 ? prompt : "") + lastSegment);
  return { x: lastWidth % width, y: row + Math.floor(lastWidth / width) };
}

interface InputState {
  line: EditLine;
  /** 줄 끝 \\로 이어 받는 중인 앞 줄들(입력한 그대로). */
  collectedLines: string[];
  history: readonly string[];
  /** -1은 기록이 아닌 지금 쓰는 줄(draft)을 보고 있다는 뜻이다. */
  historyIndex: number;
  draft: string;
}

/** 프롬프트 입력창. Shift+Enter·Option+Enter나 줄 끝 \\ + Enter로 여러 줄을 받고, ↑/↓로 입력 기록을 오간다. */
export function InputBox({
  isActive,
  initialHistory,
  onSubmit,
  onInterrupt,
  onHistoryChange,
  onExit,
  originRow,
}: InputBoxProps) {
  const multiline = useRef(new MultilineBuffer()).current;
  const { setCursorPosition } = useCursor();
  const { stdout } = useStdout();
  // Ink는 한 청크의 여러 키(Backspace 꾹 누름 등)를 렌더 없이 연달아 넘기므로,
  // 렌더 시점 값 대신 ref의 최신 상태를 읽고 바꾼 뒤 다시 그린다.
  const stateRef = useRef<InputState>({
    line: EMPTY_LINE,
    collectedLines: [],
    history: initialHistory,
    historyIndex: -1,
    draft: "",
  });
  const [, rerender] = useReducer((count: number) => count + 1, 0);

  const update = (changes: Partial<InputState>): void => {
    stateRef.current = { ...stateRef.current, ...changes };
    rerender();
  };

  const editLine = (edit: (line: EditLine) => EditLine): void => {
    update({ line: edit(stateRef.current.line) });
  };

  const showHistoryEntry = (index: number): void => {
    const { history, draft } = stateRef.current;
    update({ historyIndex: index, line: lineOf(index === -1 ? draft : (history[index] ?? "")) });
  };

  // readline처럼 빈 줄과 직전과 같은 줄은 기록하지 않는다. 기록 파일은 줄 단위라 줄바꿈이 든 붙여넣기도 뺀다.
  const recordHistory = (text: string): void => {
    const { history } = stateRef.current;
    if (text === "" || text.includes("\n") || text === history[0]) {
      return;
    }
    const next = [text, ...history].slice(0, HISTORY_SIZE);
    update({ history: next });
    onHistoryChange?.(next);
  };

  const submitLine = (): void => {
    const text = stateRef.current.line.chars.join("");
    recordHistory(text);
    update({ line: EMPTY_LINE, historyIndex: -1, draft: "" });
    const completed = multiline.push(text);
    if (completed === undefined) {
      update({ collectedLines: [...stateRef.current.collectedLines, text] });
      return;
    }
    update({ collectedLines: [] });
    onSubmit(completed);
  };

  // 한글 IME 조합 중 Return처럼 글자와 Enter가 한 청크로 오면 Ink는 return 키로 보지 않는다.
  // readline처럼 줄 경계마다 그 앞까지 넣고 제출한다.
  const typeText = (text: string): void => {
    const lines = text.split(LINE_BREAK);
    const last = lines.pop() ?? "";
    for (const line of lines) {
      editLine((current) => insertText(current, line));
      submitLine();
    }
    if (last !== "") {
      editLine((current) => insertText(current, last));
    }
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        if (multiline.isCollecting) {
          multiline.reset();
          update({ collectedLines: [], line: EMPTY_LINE });
          return;
        }
        onInterrupt();
        return;
      }
      const { historyIndex, history } = stateRef.current;
      if (key.ctrl && input === "d") {
        // readline처럼 입력 중인 글자가 있으면 무시한다.
        if (stateRef.current.line.chars.length === 0) {
          onExit?.();
        }
      } else if (key.return && (key.shift || key.meta)) {
        // Shift+Enter(kitty keyboard protocol)·Option+Enter는 제출하지 않고 줄을 바꾼다.
        editLine((line) => insertText(line, "\n"));
      } else if (key.return) {
        submitLine();
      } else if (key.upArrow) {
        if (historyIndex + 1 < history.length) {
          if (historyIndex === -1) {
            update({ draft: stateRef.current.line.chars.join("") });
          }
          showHistoryEntry(historyIndex + 1);
        }
      } else if (key.downArrow) {
        if (historyIndex >= 0) {
          showHistoryEntry(historyIndex - 1);
        }
      } else if (key.leftArrow) {
        editLine((line) => moveCursor(line, line.cursor - 1));
      } else if (key.rightArrow) {
        editLine((line) => moveCursor(line, line.cursor + 1));
      } else if (key.home || (key.ctrl && input === "a")) {
        editLine((line) => moveCursor(line, 0));
      } else if (key.end || (key.ctrl && input === "e")) {
        editLine((line) => moveCursor(line, line.chars.length));
      } else if (key.ctrl && input === "u") {
        editLine((line) => ({ chars: line.chars.slice(line.cursor), cursor: 0 }));
      } else if (key.backspace) {
        editLine(deleteBackward);
      } else if (key.delete) {
        editLine(deleteForward);
      } else if (!key.ctrl && !key.meta && !key.escape && !key.tab && input !== "") {
        typeText(input);
      }
    },
    { isActive },
  );

  // 대괄호 붙여넣기는 줄바꿈째 넣고, 보내기는 사용자가 Enter로 한다.
  usePaste(
    (text) => {
      editLine((line) => insertText(line, text.split(LINE_BREAK).join("\n")));
    },
    { isActive },
  );

  const { line, collectedLines } = stateRef.current;
  const before = line.chars.slice(0, line.cursor).join("");
  const atCursor = line.chars[line.cursor];
  const after = line.chars.slice(line.cursor + 1).join("");
  // 줄바꿈 위에 커서가 있으면 빈칸에 커서를 그리고 줄바꿈은 그대로 둔다.
  const cursorChar = atCursor === undefined || atCursor === "\n" ? " " : atCursor;
  const rest = atCursor === "\n" ? `\n${after}` : after;

  // 입력창 위치를 알면 실제 커서를 커서 칸에 두고, 모르면(첫 레이아웃 전·테스트) 반전 글자로 커서를 그린다.
  const usesTerminalCursor = isActive && originRow !== undefined;
  if (usesTerminalCursor) {
    const offset = inputCursorOffset({ collectedLines, textBeforeCursor: before, columns: columnsOf(stdout) });
    setCursorPosition({ x: offset.x, y: originRow + offset.y });
  } else {
    setCursorPosition(undefined);
  }

  return (
    <Box flexDirection="column">
      {collectedLines.map((collected, index) => (
        <Text key={index}>
          <Text dimColor>{index === 0 ? PROMPT : CONTINUATION_PROMPT}</Text>
          {collected}
        </Text>
      ))}
      <Text>
        <Text dimColor>{collectedLines.length === 0 ? PROMPT : CONTINUATION_PROMPT}</Text>
        {isActive && !usesTerminalCursor ? (
          <>
            {before}
            <Text inverse>{cursorChar}</Text>
            {rest}
          </>
        ) : (
          line.chars.join("")
        )}
      </Text>
    </Box>
  );
}
