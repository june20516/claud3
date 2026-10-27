import { type DOMElement, useWindowSize } from "ink";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/**
 * 상자의 top(부모 안에서 센 행)을 잰다. 첫 레이아웃 전에는 undefined.
 *
 * ink의 useBoxMetrics는 값이 같아도 렌더마다 setState해서, 스토어 갱신이 마이크로태스크 간격으로
 * 연달아 오면 React가 "Maximum update depth exceeded"로 멈춘다. 그래서 값이 바뀔 때만 setState한다.
 * ink는 커밋 중 layout effect 전에 레이아웃을 계산하므로 여기서 읽는 값은 이번 커밋의 것이다.
 */
export function useBoxTop(ref: RefObject<DOMElement | null>): number | undefined {
  // 터미널 크기가 바뀌면 다시 그려 줄 넘김이 바뀐 위치를 잰다.
  useWindowSize();
  const [top, setTop] = useState<number | undefined>(undefined);
  const measuredTopRef = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const nextTop = ref.current?.yogaNode?.getComputedLayout().top;
    if (nextTop !== measuredTopRef.current) {
      measuredTopRef.current = nextTop;
      setTop(nextTop);
    }
  });

  return top;
}
