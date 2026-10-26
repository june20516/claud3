import { Box, Text, useInput } from "ink";
import { useReducer, useRef } from "react";
import type { UserQuestion } from "../../types.js";
import { formatOption, formatQuestionTitle, joinLabels } from "../../userQuestions.js";

const TYPE_OWN_ANSWER = "직접 입력";

export interface QuestionDialogProps {
  question: UserQuestion;
  index: number;
  total: number;
  /** 직접 입력 중이면 답은 아래 입력창이 받고, 여기서는 Esc만 받는다. */
  typing: boolean;
  onAnswer: (answer: string) => void;
  onStartTyping: () => void;
  onStopTyping: () => void;
  onCancel: () => void;
}

interface SelectionState {
  /** 선택지 뒤의 options.length 번째는 "직접 입력"이다. */
  selected: number;
  checked: ReadonlySet<number>;
}

/**
 * AskUserQuestion 질문 하나. ↑/↓·Enter나 숫자 키로 고르고, 복수 선택은 Space·숫자로 체크한다.
 * "직접 입력"을 고르면 입력창으로 답을 받는다(한글 IME 커서를 입력창이 맞춘다). Esc는 취소한다.
 * Ctrl+C(취소 후 턴 중단)는 세션을 아는 App이 처리한다.
 */
export function QuestionDialog({
  question,
  index,
  total,
  typing,
  onAnswer,
  onStartTyping,
  onStopTyping,
  onCancel,
}: QuestionDialogProps) {
  const ownAnswerIndex = question.options.length;
  // 한 청크의 여러 키가 렌더 없이 연달아 오므로 선택 상태는 ref에서 읽고 바꾼다.
  const stateRef = useRef<SelectionState>({ selected: 0, checked: new Set() });
  const [, rerender] = useReducer((count: number) => count + 1, 0);

  const update = (changes: Partial<SelectionState>): void => {
    stateRef.current = { ...stateRef.current, ...changes };
    rerender();
  };

  const select = (target: number): void => {
    update({ selected: Math.min(Math.max(target, 0), ownAnswerIndex) });
  };

  const toggle = (optionIndex: number): void => {
    const checked = new Set(stateRef.current.checked);
    if (checked.has(optionIndex)) {
      checked.delete(optionIndex);
    } else {
      checked.add(optionIndex);
    }
    update({ selected: optionIndex, checked });
  };

  /** 선택지를 고른다. 복수 선택은 체크를 바꾸고, 단일 선택은 바로 답한다. */
  const choose = (optionIndex: number): void => {
    if (optionIndex === ownAnswerIndex) {
      onStartTyping();
      return;
    }
    const option = question.options[optionIndex];
    if (option === undefined) {
      return;
    }
    if (question.multiSelect) {
      toggle(optionIndex);
      return;
    }
    onAnswer(option.label);
  };

  const confirm = (): void => {
    const { selected, checked } = stateRef.current;
    if (selected === ownAnswerIndex) {
      onStartTyping();
      return;
    }
    if (question.multiSelect && checked.size > 0) {
      const labels = question.options.filter((_option, optionIndex) => checked.has(optionIndex)).map((option) => option.label);
      onAnswer(joinLabels(labels));
      return;
    }
    const option = question.options[selected];
    if (option !== undefined) {
      onAnswer(option.label);
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      if (typing) {
        onStopTyping();
      } else {
        onCancel();
      }
      return;
    }
    if (typing || key.ctrl || key.meta) {
      return;
    }
    if (key.upArrow) {
      select(stateRef.current.selected - 1);
    } else if (key.downArrow) {
      select(stateRef.current.selected + 1);
    } else if (key.return) {
      confirm();
    } else if (input === " " && question.multiSelect) {
      choose(stateRef.current.selected);
    } else if (/^[1-9]$/.test(input)) {
      const optionIndex = Number(input) - 1;
      if (optionIndex <= ownAnswerIndex) {
        select(optionIndex);
        choose(optionIndex);
      }
    }
  });

  const { selected, checked } = stateRef.current;
  const rows = [...question.options.map(formatOption), TYPE_OWN_ANSWER];

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{formatQuestionTitle(question, index, total)}</Text>
      {rows.map((row, rowIndex) => {
        const isSelected = !typing && rowIndex === selected;
        const isOption = rowIndex < ownAnswerIndex;
        const checkbox = question.multiSelect && isOption ? (checked.has(rowIndex) ? "[x] " : "[ ] ") : "";
        return (
          <Text key={rowIndex} color={isSelected ? "cyan" : undefined}>
            {isSelected ? "❯ " : "  "}
            {checkbox}
            {rowIndex + 1}. {row}
          </Text>
        );
      })}
      <Text dimColor>
        {typing
          ? "입력창에 답을 쓰고 Enter · Esc 선택지로"
          : question.multiSelect
            ? "Space·숫자 체크 · Enter 확정 · Esc 취소"
            : "↑/↓·숫자 선택 · Enter 확정 · Esc 취소"}
      </Text>
    </Box>
  );
}
