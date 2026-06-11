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
  /** Window-frame positions for `pos` (Oracle default-frame semantics included). */
  frame(pos: number): number[];
  /** True when the window ORDER BY ranks positions a and b as ties. */
  rowsEqual(a: number, b: number): boolean;
  /** Oracle three-way comparison (MIN/MAX must work on any data type). */
  compare(a: CellValue, b: CellValue): number;
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

function numericFrameValues(p: WindowPartition, frame: number[]): number[] {
  const values: number[] = [];
  for (const f of frame) {
    const v = p.arg(0, f);
    if (v !== null && v !== undefined) values.push(Number(v));
  }
  return values;
}

function frameAggregate(compute: (p: WindowPartition, frame: number[]) => CellValue): WindowFunctionImpl {
  return (p) => {
    const out: CellValue[] = new Array(p.size);
    for (let pos = 0; pos < p.size; pos++) out[pos] = compute(p, p.frame(pos));
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
  frame.length === 0 ? null : p.arg(0, frame[0]));

const LAST_VALUE = frameAggregate((p, frame) =>
  frame.length === 0 ? null : p.arg(0, frame[frame.length - 1]));

const NTH_VALUE: WindowFunctionImpl = (p) => {
  const out: CellValue[] = new Array(p.size);
  for (let pos = 0; pos < p.size; pos++) {
    const n = p.argCount > 1 ? Number(p.arg(1, pos)) : 1;
    const frame = p.frame(pos);
    out[pos] = n < 1 || n > frame.length ? null : p.arg(0, frame[n - 1]);
  }
  return out;
};

const COUNT = frameAggregate((p, frame) => {
  if (p.star) return frame.length;
  let count = 0;
  for (const f of frame) {
    const v = p.arg(0, f);
    if (v !== null && v !== undefined) count++;
  }
  return count;
});

const SUM = frameAggregate((p, frame) => {
  const values = numericFrameValues(p, frame);
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
});

const AVG = frameAggregate((p, frame) => {
  const values = numericFrameValues(p, frame);
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
});

/**
 * MIN/MAX use the Oracle comparator so strings and dates order
 * correctly. `direction` −1 keeps the smaller value, +1 the larger.
 */
function extremum(direction: -1 | 1): WindowFunctionImpl {
  return frameAggregate((p, frame) => {
    let best: CellValue = null;
    for (const f of frame) {
      const v = p.arg(0, f);
      if (v === null || v === undefined) continue;
      if (best === null || direction * p.compare(v, best) > 0) best = v;
    }
    return best;
  });
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
