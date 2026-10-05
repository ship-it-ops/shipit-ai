/** pgvector's text input form. Pass it as `$n::halfvec`; no driver extension needed. */
export function toPgVector(values: ArrayLike<number>): string {
  const parts: string[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) throw new Error(`embedding value at ${i} is not finite`);
    parts[i] = String(v);
  }
  return `[${parts.join(',')}]`;
}
