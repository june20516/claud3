import { Box, Text, useInput } from "ink";
import { useReducer, useRef } from "react";
import type { PermissionDecision, PermissionRequest } from "../../types.js";
import { parseDecision, parsePlanDecision } from "../plain.js";

interface Choice {
  label: string;
  shortcut: string;
  decision: PermissionDecision;
}

const TOOL_CHOICES: readonly Choice[] = [
  { label: "이번만 허용", shortcut: "y", decision: "allow" },
  { label: "세션 동안 항상 허용", shortcut: "a", decision: "always" },
  { label: "거부", shortcut: "n", decision: "deny" },
];

const PLAN_CHOICES: readonly Choice[] = [
  { label: "승인", shortcut: "y", decision: "allow" },
  { label: "승인+편집 자동 허용", shortcut: "e", decision: "allowAcceptEdits" },
  { label: "계속 계획", shortcut: "n", decision: "deny" },
];

export interface PermissionDialogProps {
  request: PermissionRequest;
  onDecision: (decision: PermissionDecision) => void;
}

/**
 * 도구 권한 또는 계획 승인 질문. ↑/↓·Enter나 단축키로 고르고 Esc는 거부한다.
 * Ctrl+C(거부 후 턴 중단)는 세션을 아는 App이 처리한다.
 */
export function PermissionDialog({ request, onDecision }: PermissionDialogProps) {
  const isPlan = request.plan !== undefined;
  const choices = isPlan ? PLAN_CHOICES : TOOL_CHOICES;
  const parse = isPlan ? parsePlanDecision : parseDecision;
  const title = isPlan ? "계획을 승인할까요?" : `${request.toolName}(${request.summary}) 허용할까요?`;
  // 한 청크의 여러 키(↓↓ Enter)가 렌더 없이 연달아 오므로 선택은 ref에서 읽고 바꾼다.
  const selectedRef = useRef(0);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const select = (index: number): void => {
    selectedRef.current = Math.min(Math.max(index, 0), choices.length - 1);
    rerender();
  };
  const selected = selectedRef.current;

  useInput((input, key) => {
    if (key.escape) {
      onDecision("deny");
      return;
    }
    if (key.upArrow) {
      select(selectedRef.current - 1);
      return;
    }
    if (key.downArrow) {
      select(selectedRef.current + 1);
      return;
    }
    if (key.return) {
      const choice = choices[selectedRef.current];
      if (choice !== undefined) {
        onDecision(choice.decision);
      }
      return;
    }
    if (key.ctrl || key.meta) {
      return;
    }
    const decision = parse(input);
    if (decision !== undefined) {
      onDecision(decision);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{title}</Text>
      {choices.map((choice, index) => (
        <Text key={choice.shortcut} color={index === selected ? "cyan" : undefined}>
          {index === selected ? "❯ " : "  "}
          {choice.label} ({choice.shortcut})
        </Text>
      ))}
    </Box>
  );
}
