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

/** 결과 메시지의 structured_output과 비용을 돌려준다. 실패 결과면 OneShotQueryError를 던진다. */
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
    return { output: message.structured_output, costUsd: message.total_cost_usd ?? 0 };
  }
  throw new OneShotQueryError("no_result", 0);
}
