/** 코드 포인트 단위로 앞에서 max자만 남긴다. UTF-16 slice와 달리 이모지를 반으로 자르지 않는다. */
export function sliceChars(text: string, max: number): string {
  const characters = [...text];
  return characters.length > max ? characters.slice(0, max).join("") : text;
}

/** 코드 포인트 단위 글자 수. */
export function charCount(text: string): number {
  return [...text].length;
}
