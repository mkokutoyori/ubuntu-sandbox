import type { CellValue } from '../../engine/storage/BaseStorage';

/**
 * One window-ordered partition of an analytic function evaluation.
 * The executor owns partitioning, ordering and frame resolution; the
 * function implementations are pure and vectorized — they return one
 * value per partition position, which keeps rank-family functions O(n)
 * instead of recomputing per row.
 */
export interface WindowPartition {
  /** Number of rows in the partition (window-ordered). */
  size: number;
  /** Number of arguments in the call. */
  argCount: number;
  /** COUNT(*) / argument-less form. */
  star: boolean;
  /** Evaluate the i-th argument against the row at partition position `pos`. */
  arg(i: number, pos: number): CellValue;
  frame(pos: number): FrameRange;
  /** True when the window ORDER BY ranks positions a and b as ties. */
  rowsEqual(a: number, b: number): boolean;
  /** Oracle three-way comparison (MIN/MAX must work on any data type). */
  compare(a: CellValue, b: CellValue): number;
}

export interface FrameRange {
  start: number;
  end: number;
}

export type WindowFunctionImpl = (p: WindowPartition) => CellValue[];

/** RANK values for every position — shared by RANK / PERCENT_RANK. */
function rankValues(p: WindowPartition): number[] {
  const ranks: number[] = new Array(p.size);
  for (let pos = 0; pos < p.size; pos++) {
    ranks[pos] = pos > 0 && p.rowsEqual(pos - 1, pos) ? ranks[pos - 1] : pos + 1;
  }
  return ranks;
}

function frameLength(frame: FrameRange): number {
  return frame.end < frame.start ? 0 : frame.end - frame.start + 1;
}

function frameAggregate(compute: (p: WindowPartition, frame: FrameRange) => CellValue): WindowFunctionImpl {
  return (p) => {
    const out: CellValue[] = new Array(p.size);
    for (let pos = 0; pos < p.size; pos++) out[pos] = compute(p, p.frame(pos));
    return out;
  };
}

function accumulatingAggregate<A>(
  start: () => A,
  add: (acc: A, value: CellValue) => void,
  finish: (acc: A, frameSize: number) => CellValue,
): WindowFunctionImpl {
  return (p) => {
    const out: CellValue[] = new Array(p.size);
    let acc = start();
    let from = 0;
    let to = -1;
    for (let pos = 0; pos < p.size; pos++) {
      const frame = p.frame(pos);
      if (frame.start !== from || frame.end < to) {
        acc = start();
        from = frame.start;
        to = frame.start - 1;
      }
      for (let f = to + 1; f <= frame.end; f++) add(acc, p.arg(0, f));
      if (frame.end > to) to = frame.end;
      out[pos] = finish(acc, frameLength(frame));
    }
    return out;
  };
}

const ROW_NUMBER: WindowFunctionImpl = (p) =>
  Array.from({ length: p.size }, (_, pos) => pos + 1);

const RANK: WindowFunctionImpl = (p) => rankValues(p);

const DENSE_RANK: WindowFunctionImpl = (p) => {
  const out: number[] = new Array(p.size);
  for (let pos = 0; pos < p.size; pos++) {
    if (pos === 0) out[pos] = 1;
    else out[pos] = p.rowsEqual(pos - 1, pos) ? out[pos - 1] : out[pos - 1] + 1;
  }
  return out;
};

/** Oracle: (rank − 1) / (rows − 1); 0 for a single-row partition. */
const PERCENT_RANK: WindowFunctionImpl = (p) => {
  if (p.size === 1) return [0];
  return rankValues(p).map(r => (r - 1) / (p.size - 1));
};

/** Oracle: rows preceding or tied with the current row / total rows. */
const CUME_DIST: WindowFunctionImpl = (p) => {
  const out: number[] = new Array(p.size);
  let groupEnd = -1;
  for (let pos = 0; pos < p.size; pos++) {
    if (pos > groupEnd) {
      groupEnd = pos;
      while (groupEnd + 1 < p.size && p.rowsEqual(groupEnd, groupEnd + 1)) groupEnd++;
    }
    out[pos] = (groupEnd + 1) / p.size;
  }
  return out;
};

const NTILE: WindowFunctionImpl = (p) => {
  const out: CellValue[] = new Array(p.size);
  for (let pos = 0; pos < p.size; pos++) {
    const buckets = p.argCount > 0 ? Number(p.arg(0, pos)) : 1;
    out[pos] = Math.floor(pos * buckets / p.size) + 1;
  }
  return out;
};

function lagLead(direction: -1 | 1): WindowFunctionImpl {
  return (p) => {
    const out: CellValue[] = new Array(p.size);
    for (let pos = 0; pos < p.size; pos++) {
      const offset = p.argCount > 1 ? Number(p.arg(1, pos)) : 1;
      const target = pos + direction * offset;
      if (target < 0 || target >= p.size) {
        out[pos] = p.argCount > 2 ? p.arg(2, pos) : null;
      } else {
        out[pos] = p.arg(0, target);
      }
    }
    return out;
  };
}

const FIRST_VALUE = frameAggregate((p, frame) =>
  frameLength(frame) === 0 ? null : p.arg(0, frame.start));

const LAST_VALUE = frameAggregate((p, frame) =>
  frameLength(frame) === 0 ? null : p.arg(0, frame.end));

const NTH_VALUE: WindowFunctionImpl = (p) => {
  const out: CellValue[] = new Array(p.size);
  for (let pos = 0; pos < p.size; pos++) {
    const n = p.argCount > 1 ? Number(p.arg(1, pos)) : 1;
    const frame = p.frame(pos);
    out[pos] = n < 1 || n > frameLength(frame) ? null : p.arg(0, frame.start + n - 1);
  }
  return out;
};

interface RunningSum {
  total: number;
  count: number;
}

const COUNT: WindowFunctionImpl = (p) => {
  if (p.star) return frameAggregate((_, frame) => frameLength(frame))(p);
  return accumulatingAggregate(
    () => ({ count: 0 }),
    (acc, v) => { if (v !== null && v !== undefined) acc.count++; },
    (acc) => acc.count,
  )(p);
};

const SUM = accumulatingAggregate<RunningSum>(
  () => ({ total: 0, count: 0 }),
  (acc, v) => {
    if (v === null || v === undefined) return;
    acc.total += Number(v);
    acc.count++;
  },
  (acc) => (acc.count === 0 ? null : acc.total),
);

const AVG = accumulatingAggregate<RunningSum>(
  () => ({ total: 0, count: 0 }),
  (acc, v) => {
    if (v === null || v === undefined) return;
    acc.total += Number(v);
    acc.count++;
  },
  (acc) => (acc.count === 0 ? null : acc.total / acc.count),
);

/**
 * MIN/MAX use the Oracle comparator so strings and dates order
 * correctly. `direction` −1 keeps the smaller value, +1 the larger.
 */
function extremum(direction: -1 | 1): WindowFunctionImpl {
  return (p) => accumulatingAggregate<{ best: CellValue }>(
    () => ({ best: null }),
    (acc, v) => {
      if (v === null || v === undefined) return;
      if (acc.best === null || direction * p.compare(v, acc.best) > 0) acc.best = v;
    },
    (acc) => acc.best,
  )(p);
}

const WINDOW_FUNCTIONS: ReadonlyMap<string, WindowFunctionImpl> = new Map<string, WindowFunctionImpl>([
  ['ROW_NUMBER', ROW_NUMBER],
  ['RANK', RANK],
  ['DENSE_RANK', DENSE_RANK],
  ['PERCENT_RANK', PERCENT_RANK],
  ['CUME_DIST', CUME_DIST],
  ['NTILE', NTILE],
  ['LAG', lagLead(-1)],
  ['LEAD', lagLead(1)],
  ['FIRST_VALUE', FIRST_VALUE],
  ['LAST_VALUE', LAST_VALUE],
  ['NTH_VALUE', NTH_VALUE],
  ['COUNT', COUNT],
  ['SUM', SUM],
  ['AVG', AVG],
  ['MIN', extremum(-1)],
  ['MAX', extremum(1)],
]);

export function resolveWindowFunction(name: string): WindowFunctionImpl | undefined {
  return WINDOW_FUNCTIONS.get(name.toUpperCase());
}
