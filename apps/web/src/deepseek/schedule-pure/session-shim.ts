/** The schedule replay helpers only require these two structural fields. */
export type SessionLogOffset = number;
export function SessionLogOffset(value: number): SessionLogOffset {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid schedule log offset");
  return value;
}
export interface SessionEvent { readonly type: string; readonly data: unknown }
