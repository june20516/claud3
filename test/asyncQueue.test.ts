import { describe, expect, it } from "vitest";
import { AsyncQueue } from "../src/asyncQueue.js";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

describe("AsyncQueue", () => {
  it("push한 순서대로 꺼낸다", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();
    expect(await collect(queue)).toEqual([1, 2]);
  });

  it("비어 있으면 다음 push까지 기다린다", async () => {
    const queue = new AsyncQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    queue.push("a");
    expect(await pending).toEqual({ value: "a", done: false });
  });

  it("close 후 반복이 끝난다 (남은 항목은 먼저 꺼낸다)", async () => {
    const queue = new AsyncQueue<number>();
    const collected = collect(queue);
    queue.push(1);
    queue.close();
    expect(await collected).toEqual([1]);
  });

  it("close 후 push는 무시한다", async () => {
    const queue = new AsyncQueue<number>();
    queue.close();
    queue.push(1);
    expect(await collect(queue)).toEqual([]);
  });
});
