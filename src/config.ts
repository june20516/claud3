import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { SelectablePermissionMode } from "./permissionModes.js";

export interface BaseOptionsParams {
  cwd: string;
  apiKey: string;
  model?: string;
  permissionMode?: SelectablePermissionMode;
}

/**
 * Claude Code와 같은 환경으로 동작하도록 SDK 옵션을 만든다.
 * 플러그인은 settingSources의 enabledPlugins로 자동 로드되므로 따로 넘기지 않는다
 * (docs/suberpowers/notes/probe-results.md 3번).
 */
export function buildBaseOptions({ cwd, apiKey, model, permissionMode }: BaseOptionsParams): Options {
  return {
    cwd,
    settingSources: ["user", "project", "local"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    includePartialMessages: true,
    env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
    ...(model === undefined ? {} : { model }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
  };
}
