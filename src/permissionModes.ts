import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

/** 사용자에게 노출하는 권한 모드. 배열 순서가 Shift+Tab 순환 순서다. */
export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto"] as const;

export type SelectablePermissionMode = (typeof PERMISSION_MODES)[number];

export const PERMISSION_MODE_DESCRIPTIONS: Record<SelectablePermissionMode, string> = {
  default: "위험한 도구는 매번 묻기",
  acceptEdits: "파일 편집은 묻지 않고 허용",
  plan: "계획만 세우고 도구 실행 안 함",
  auto: "분류기가 판단, 애매하면 묻기",
};

export function unknownPermissionModeMessage(value: string): string {
  return `알 수 없는 권한 모드: ${value} (${PERMISSION_MODES.join(", ")})`;
}

/** 모드 이름과 정확히 일치할 때만 반환한다 (대소문자 구분). */
export function parsePermissionMode(text: string): SelectablePermissionMode | undefined {
  return (PERMISSION_MODES as readonly string[]).includes(text) ? (text as SelectablePermissionMode) : undefined;
}

/**
 * 다음 모드를 반환한다.
 * 현재 모드가 없으면 default로 보고 다음 모드를 반환한다.
 * 목록 밖 모드(예: dontAsk, bypassPermissions)는 default를 반환한다.
 */
export function nextPermissionMode(current: PermissionMode | undefined): SelectablePermissionMode {
  if (current === undefined) {
    return nextAfter("default");
  }
  const selectable = parsePermissionMode(current);
  return selectable === undefined ? PERMISSION_MODES[0] : nextAfter(selectable);
}

export function describePermissionMode(mode: PermissionMode): string {
  const selectable = parsePermissionMode(mode);
  return selectable === undefined ? mode : `${mode} — ${PERMISSION_MODE_DESCRIPTIONS[selectable]}`;
}

function nextAfter(mode: SelectablePermissionMode): SelectablePermissionMode {
  const index = PERMISSION_MODES.indexOf(mode);
  return PERMISSION_MODES[(index + 1) % PERMISSION_MODES.length];
}
