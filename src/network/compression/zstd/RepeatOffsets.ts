export type RepeatHistory = [number, number, number];

export function initialRepeatHistory(): RepeatHistory {
  return [1, 4, 8];
}

export function resolveOffset(offsetValue: number, literalLength: number, history: RepeatHistory): number {
  if (offsetValue > 3) {
    const offset = offsetValue - 3;
    history[2] = history[1];
    history[1] = history[0];
    history[0] = offset;
    return offset;
  }
  const slot = offsetValue - 1 + (literalLength === 0 ? 1 : 0);
  if (slot === 0) return history[0];
  const offset = slot === 3 ? history[0] - 1 : history[slot];
  if (offset === 0) return 0;
  if (slot !== 1) history[2] = history[1];
  history[1] = history[0];
  history[0] = offset;
  return offset;
}

export function offsetValueFor(offset: number, literalLength: number, history: RepeatHistory): number {
  if (literalLength > 0) {
    if (offset === history[0]) return 1;
    if (offset === history[1]) return 2;
    if (offset === history[2]) return 3;
  } else {
    if (offset === history[1]) return 1;
    if (offset === history[2]) return 2;
    if (offset === history[0] - 1 && offset > 0) return 3;
  }
  return offset + 3;
}
