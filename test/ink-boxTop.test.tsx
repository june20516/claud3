import { Box, Text, type DOMElement } from "ink";
import { render } from "ink-testing-library";
import { useRef, useSyncExternalStore } from "react";
import { describe, expect, it } from "vitest";
import { useBoxTop } from "../src/ui/ink/useBoxTop.js";

/** 값이 바뀔 때마다 구독자에게 알리는 최소 스토어. */
function createCounterStore() {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => value,
    increment: () => {
      value += 1;
      listeners.forEach((listener) => listener());
    },
  };
}

/** 위에 lineCount줄을 그리고 그 아래 상자의 top을 보인다. */
function TopProbe({ lineCount }: { lineCount: number }) {
  const ref = useRef<DOMElement>(null);
  const top = useBoxTop(ref);
  return (
    <Box flexDirection="column">
      {Array.from({ length: lineCount }, (_, index) => (
        <Text key={index}>{`줄 ${index}`}</Text>
      ))}
      <Box ref={ref}>
        <Text>{`top=${top ?? "?"}`}</Text>
      </Box>
    </Box>
  );
}

const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("useBoxTop", () => {
  it("위에 그린 줄 수만큼의 top을 재고, 줄이 늘면 다시 잰다", async () => {
    const view = render(<TopProbe lineCount={2} />);
    await nextTick();
    expect(view.lastFrame()).toContain("top=2");

    view.rerender(<TopProbe lineCount={4} />);
    await nextTick();
    expect(view.lastFrame()).toContain("top=4");
  });

  it("스토어 갱신이 마이크로태스크 간격으로 연달아 와도 무한 갱신 오류 없이 위치를 따라간다", async () => {
    const store = createCounterStore();
    function StoreProbe() {
      const count = useSyncExternalStore(store.subscribe, store.getSnapshot);
      return <TopProbe lineCount={1 + Math.floor(count / 50)} />;
    }
    const view = render(<StoreProbe />);
    await nextTick();

    // SDK 메시지를 for await로 받아 이벤트마다 스토어를 갱신하는 흐름과 같은 간격이다.
    for (let index = 0; index < 200; index++) {
      store.increment();
      await Promise.resolve();
    }
    await nextTick();

    expect(view.lastFrame()).toContain("top=5");
  });
});
