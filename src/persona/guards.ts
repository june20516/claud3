export type UnknownRecord = Record<string, unknown>;

/** 배열이 아닌 객체인지. JSON에서 읽은 unknown 값을 좁힐 때 쓴다. */
export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
