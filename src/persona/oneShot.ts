import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** 한 번 묻고 끝나는 query(). 실제 값은 SDK의 query다. */
export type OneShotQueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface OneShotResult {
  output: unknown;
  costUsd: number;
}

/** 실패한 one-shot도 비용이 들므로 함께 담는다. */
export class OneShotQueryError extends Error {
  constructor(
    readonly subtype: string,
    readonly costUsd: number,
  ) {
    super(`one-shot query 실패: ${subtype}`);
    this.name = "OneShotQueryError";
  }
}

const JSON_FENCE_PATTERN = /```(?:json)?\s*\n([\s\S]*?)\n```/;

/** 결과 글에서 JSON을 읽는다. 코드 펜스가 있으면 그 안을, 없으면 첫 { 부터 마지막 } 까지. */
function parseJsonFromText(text: string | undefined): unknown {
  if (text === undefined) {
    return undefined;
  }
  const fenced = JSON_FENCE_PATTERN.exec(text)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return candidate === "" ? undefined : (JSON.parse(candidate) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * 결과 메시지의 structured_output과 비용을 돌려준다. 실패 결과면 OneShotQueryError를 던진다.
 * structured_output이 비어 있으면 결과 글의 JSON을 쓴다(도구를 막은 호출에서 구조화 출력이 빠지는 경우 대비).
 */
export async function runStructuredQuery(
  queryFn: OneShotQueryFn,
  prompt: string,
  options: Options,
  onMessage?: (message: SDKMessage) => void,
): Promise<OneShotResult> {
  for await (const message of queryFn({ prompt, options })) {
    onMessage?.(message);
    if (message.type !== "result") {
      continue;
    }
    if (message.subtype !== "success") {
      throw new OneShotQueryError(message.subtype, message.total_cost_usd ?? 0);
    }
    const output = message.structured_output ?? parseJsonFromText(message.result);
    return { output, costUsd: message.total_cost_usd ?? 0 };
  }
  throw new OneShotQueryError("no_result", 0);
}
