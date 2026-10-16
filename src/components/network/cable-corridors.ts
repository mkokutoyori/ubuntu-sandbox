import type { Point } from './connection-line-logic';

export interface CorridorRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly owner: Point;
}

export interface CorridorLink {
  readonly source: Point;
  readonly target: Point;
  readonly horizontal: boolean;
  readonly points: Point[];
  readonly low: number;
  readonly high: number;
  readonly preferred?: number;
}

const CROSSING_COST = 1000;
export const DEVICE_COST = 3500;
const OVERLAP_COST = 40;
const OVERLAP_BAND = 8;
const DEVIATION_COST = 0.3;
const STEP = 12;
const REACH = 6;
const SWEEPS = 4;

const EDGE_GAP = 14;
const WINDOW_REACH = 160;
const WORK_LIMIT = 60000;
const CANDIDATES_PER_LINK = 16;

const SEGMENTS = 3;
const STRIDE = 8;

function flatten(points: ReadonlyArray<Point>, into: Float64Array, at: number): void {
  for (let i = 0; i < 4; i++) {
    into[at + 2 * i] = points[i].x;
    into[at + 2 * i + 1] = points[i].y;
  }
}

function withCorridor(horizontal: boolean, shape: Float64Array, offset: number, corridor: number, into: Float64Array): void {
  for (let i = 0; i < STRIDE; i++) into[i] = shape[offset + i];
  if (horizontal) { into[2] = corridor; into[4] = corridor; } else { into[3] = corridor; into[5] = corridor; }
}

function segmentCost(
  ax0: number, ay0: number, ax1: number, ay1: number,
  bx0: number, by0: number, bx1: number, by1: number,
): number {
  const aHorizontal = ay0 === ay1;
  const bHorizontal = by0 === by1;
  if (aHorizontal !== bHorizontal) {
    const hx0 = aHorizontal ? ax0 : bx0, hx1 = aHorizontal ? ax1 : bx1, hy = aHorizontal ? ay0 : by0;
    const vy0 = aHorizontal ? by0 : ay0, vy1 = aHorizontal ? by1 : ay1, vx = aHorizontal ? bx0 : ax0;
    const loX = hx0 < hx1 ? hx0 : hx1, hiX = hx0 < hx1 ? hx1 : hx0;
    const loY = vy0 < vy1 ? vy0 : vy1, hiY = vy0 < vy1 ? vy1 : vy0;
    return vx > loX + 0.5 && vx < hiX - 0.5 && hy > loY + 0.5 && hy < hiY - 0.5 ? CROSSING_COST : 0;
  }
  if (aHorizontal) {
    const gap = Math.abs(ay0 - by0);
    if (gap >= OVERLAP_BAND) return 0;
    const lo = Math.max(Math.min(ax0, ax1), Math.min(bx0, bx1));
    const hi = Math.min(Math.max(ax0, ax1), Math.max(bx0, bx1));
    return hi > lo ? (hi - lo) * (OVERLAP_BAND - gap) * OVERLAP_COST / OVERLAP_BAND : 0;
  }
  const gap = Math.abs(ax0 - bx0);
  if (gap >= OVERLAP_BAND) return 0;
  const lo = Math.max(Math.min(ay0, ay1), Math.min(by0, by1));
  const hi = Math.min(Math.max(ay0, ay1), Math.max(by0, by1));
  return hi > lo ? (hi - lo) * (OVERLAP_BAND - gap) * OVERLAP_COST / OVERLAP_BAND : 0;
}

function pathCost(
  shape: Float64Array, others: Float64Array, bounds: Float64Array, neighbours: ReadonlyArray<number>,
  rects: ReadonlyArray<CorridorRect>, limit = Infinity,
): number {
  let cost = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < STRIDE; i += 2) {
    if (shape[i] < minX) minX = shape[i];
    if (shape[i] > maxX) maxX = shape[i];
    if (shape[i + 1] < minY) minY = shape[i + 1];
    if (shape[i + 1] > maxY) maxY = shape[i + 1];
  }
  for (let n = 0; n < neighbours.length; n++) {
    const j = neighbours[n];
    const b = 4 * j;
    if (bounds[b] > maxX + OVERLAP_BAND || bounds[b + 2] < minX - OVERLAP_BAND
      || bounds[b + 1] > maxY + OVERLAP_BAND || bounds[b + 3] < minY - OVERLAP_BAND) continue;
    const base = j * STRIDE;
    for (let s = 0; s < SEGMENTS; s++) {
      const p = 2 * s;
      for (let t = 0; t < SEGMENTS; t++) {
        const q = base + 2 * t;
        cost += segmentCost(
          shape[p], shape[p + 1], shape[p + 2], shape[p + 3],
          others[q], others[q + 1], others[q + 2], others[q + 3]);
      }
    }
    if (cost >= limit) return cost;
  }
  for (let n = 0; n < rects.length; n++) {
    const rect = rects[n];
    if (maxX <= rect.x0 || minX >= rect.x1 || maxY <= rect.y0 || minY >= rect.y1) continue;
    for (let s = 0; s < SEGMENTS; s++) {
      const p = 2 * s;
      const x0 = Math.min(shape[p], shape[p + 2]), x1 = Math.max(shape[p], shape[p + 2]);
      const y0 = Math.min(shape[p + 1], shape[p + 3]), y1 = Math.max(shape[p + 1], shape[p + 3]);
      if (x0 < rect.x1 && x1 > rect.x0 && y0 < rect.y1 && y1 > rect.y0) { cost += DEVICE_COST; break; }
    }
  }
  return cost;
}

function corridorCandidates(
  link: CorridorLink, base: number, rects: ReadonlyArray<CorridorRect>, out: number[],
): void {
  out.length = 0;
  if (link.high - link.low < 1) { out.push(base); return; }
  const floor = Math.max(link.low, base - WINDOW_REACH), ceiling = Math.min(link.high, base + WINDOW_REACH);
  const clamp = (value: number): number => (value < floor ? floor : value > ceiling ? ceiling : value);
  for (let k = -REACH; k <= REACH; k++) out.push(clamp(base + k * STEP));
  const horizontal = link.horizontal;
  const spanLow = Math.min(horizontal ? link.points[0].y : link.points[0].x, horizontal ? link.points[3].y : link.points[3].x);
  const spanHigh = Math.max(horizontal ? link.points[0].y : link.points[0].x, horizontal ? link.points[3].y : link.points[3].x);
  for (let n = 0; n < rects.length; n++) {
    const rect = rects[n];
    if (isOwner(rect, link)) continue;
    const across0 = horizontal ? rect.y0 : rect.x0, across1 = horizontal ? rect.y1 : rect.x1;
    if (across1 <= spanLow || across0 >= spanHigh) continue;
    const along0 = horizontal ? rect.x0 : rect.y0, along1 = horizontal ? rect.x1 : rect.y1;
    if (along1 < floor - EDGE_GAP || along0 > ceiling + EDGE_GAP) continue;
    out.push(clamp(along0 - EDGE_GAP), clamp(along1 + EDGE_GAP));
  }
}

export interface CorridorOutcome {
  readonly chosen: Array<number | undefined>;
  readonly residual: Float64Array;
  readonly total: number;
  readonly work: number;
}

function isOwner(rect: CorridorRect, link: CorridorLink): boolean {
  return (rect.owner.x === link.source.x && rect.owner.y === link.source.y)
    || (rect.owner.x === link.target.x && rect.owner.y === link.target.y);
}

const CELL = 128;
const OFFSET = 2048;
const SPAN = 4096;
const cellOf = (value: number): number => Math.floor(value / CELL) + OFFSET;

export function refineCorridors(
  links: ReadonlyArray<CorridorLink>, rects: ReadonlyArray<CorridorRect>,
): CorridorOutcome {
  const count = links.length;
  const shapes = new Float64Array(count * STRIDE);
  const base = new Float64Array(count);
  const envelope = new Float64Array(count * 4);
  for (let i = 0; i < count; i++) {
    const link = links[i];
    flatten(link.points, shapes, i * STRIDE);
    base[i] = link.horizontal ? link.points[1].x : link.points[1].y;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < STRIDE; k += 2) {
      const x = shapes[i * STRIDE + k], y = shapes[i * STRIDE + k + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (link.high - link.low >= 1) {
      const lo = Math.max(link.low, base[i] - WINDOW_REACH);
      const hi = Math.min(link.high, base[i] + WINDOW_REACH);
      if (link.horizontal) { minX = Math.min(minX, lo); maxX = Math.max(maxX, hi); }
      else { minY = Math.min(minY, lo); maxY = Math.max(maxY, hi); }
    }
    envelope[4 * i] = minX - OVERLAP_BAND; envelope[4 * i + 1] = minY - OVERLAP_BAND;
    envelope[4 * i + 2] = maxX + OVERLAP_BAND; envelope[4 * i + 3] = maxY + OVERLAP_BAND;
  }

  const cells = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const cx1 = cellOf(envelope[4 * i + 2]), cy1 = cellOf(envelope[4 * i + 3]);
    for (let cx = cellOf(envelope[4 * i]); cx <= cx1; cx++) {
      for (let cy = cellOf(envelope[4 * i + 1]); cy <= cy1; cy++) {
        const key = cx * SPAN + cy;
        const bucket = cells.get(key);
        if (bucket) bucket.push(i); else cells.set(key, [i]);
      }
    }
  }
  const neighbours: number[][] = new Array(count);
  const nearRects: CorridorRect[][] = new Array(count);
  const stamp = new Int32Array(count).fill(-1);
  for (let i = 0; i < count; i++) {
    const list: number[] = [];
    const cx1 = cellOf(envelope[4 * i + 2]), cy1 = cellOf(envelope[4 * i + 3]);
    for (let cx = cellOf(envelope[4 * i]); cx <= cx1; cx++) {
      for (let cy = cellOf(envelope[4 * i + 1]); cy <= cy1; cy++) {
        const bucket = cells.get(cx * SPAN + cy);
        if (!bucket) continue;
        for (let n = 0; n < bucket.length; n++) {
          const j = bucket[n];
          if (j === i || stamp[j] === i) continue;
          stamp[j] = i;
          if (envelope[4 * j] > envelope[4 * i + 2] || envelope[4 * j + 2] < envelope[4 * i]
            || envelope[4 * j + 1] > envelope[4 * i + 3] || envelope[4 * j + 3] < envelope[4 * i + 1]) continue;
          list.push(j);
        }
      }
    }
    neighbours[i] = list;
    nearRects[i] = rects.filter(rect => !isOwner(rect, links[i])
      && rect.x0 < envelope[4 * i + 2] && rect.x1 > envelope[4 * i]
      && rect.y0 < envelope[4 * i + 3] && rect.y1 > envelope[4 * i + 1]);
  }

  const bounds = new Float64Array(count * 4);
  const refreshBounds = (i: number): void => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < STRIDE; k += 2) {
      const x = shapes[i * STRIDE + k], y = shapes[i * STRIDE + k + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    bounds[4 * i] = minX; bounds[4 * i + 1] = minY; bounds[4 * i + 2] = maxX; bounds[4 * i + 3] = maxY;
  };
  for (let i = 0; i < count; i++) refreshBounds(i);
  const chosen: Array<number | undefined> = new Array(count).fill(undefined);
  const candidate = new Float64Array(STRIDE);
  const options: number[] = [];
  const costOf = (index: number, corridor: number, limit = Infinity): number => {
    withCorridor(links[index].horizontal, shapes, index * STRIDE, corridor, candidate);
    const deviation = DEVIATION_COST * Math.abs(corridor - base[index]);
    return pathCost(candidate, shapes, bounds, neighbours[index], nearRects[index], limit - deviation) + deviation;
  };

  let pairs = 0;
  for (let i = 0; i < count; i++) pairs += (neighbours[i].length + nearRects[i].length) * CANDIDATES_PER_LINK;
  const sweeps = pairs === 0 ? SWEEPS : Math.min(SWEEPS, Math.floor(WORK_LIMIT / pairs));
  let work = pairs;
  for (let sweep = 0; sweep < sweeps; sweep++) {
    work += pairs;
    let moved = false;
    for (let i = 0; i < count; i++) {
      const link = links[i];
      if (link.high - link.low < 1 || (neighbours[i].length === 0 && nearRects[i].length === 0)) continue;
      const current = chosen[i] ?? base[i];
      const currentCost = costOf(i, current);
      if (currentCost < DEVIATION_COST * Math.abs(current - base[i]) + 1e-9) continue;
      let best = current;
      let bestCost = currentCost;
      corridorCandidates(link, base[i], nearRects[i], options);
      for (let k = 0; k < options.length; k++) {
        const corridor = options[k];
        if (corridor === current) continue;
        const cost = costOf(i, corridor, bestCost + 0.5) - (link.preferred !== undefined && corridor === link.preferred ? 0.5 : 0);
        if (cost < bestCost - 1e-9) { best = corridor; bestCost = cost; }
      }
      if (best !== current) {
        chosen[i] = best;
        withCorridor(link.horizontal, shapes, i * STRIDE, best, candidate);
        for (let j = 0; j < STRIDE; j++) shapes[i * STRIDE + j] = candidate[j];
        refreshBounds(i);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const residual = new Float64Array(count);
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (neighbours[i].length === 0 && nearRects[i].length === 0) continue;
    withCorridor(links[i].horizontal, shapes, i * STRIDE, chosen[i] ?? base[i], candidate);
    residual[i] = pathCost(candidate, shapes, bounds, neighbours[i], nearRects[i]);
    total += residual[i];
  }
  return { chosen, residual, total, work };
}

export interface TrialField {
  readonly shapes: Float64Array;
  readonly bounds: Float64Array;
  readonly everyone: ReadonlyArray<number>;
}

export function trialField(paths: ReadonlyArray<ReadonlyArray<Point>>): TrialField {
  const count = paths.length;
  const shapes = new Float64Array(count * STRIDE);
  const bounds = new Float64Array(count * 4);
  for (let i = 0; i < count; i++) {
    flatten(paths[i], shapes, i * STRIDE);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < STRIDE; k += 2) {
      const x = shapes[i * STRIDE + k], y = shapes[i * STRIDE + k + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    bounds[4 * i] = minX; bounds[4 * i + 1] = minY; bounds[4 * i + 2] = maxX; bounds[4 * i + 3] = maxY;
  }
  return { shapes, bounds, everyone: Array.from({ length: count }, (_, i) => i) };
}

export function trialCost(
  link: CorridorLink, skip: number, field: TrialField, rects: ReadonlyArray<CorridorRect>,
): number {
  const neighbours = field.everyone.filter(index => index !== skip);
  const own = rects.filter(rect => !isOwner(rect, link));
  const shape = new Float64Array(STRIDE);
  flatten(link.points, shape, 0);
  const base = link.horizontal ? link.points[1].x : link.points[1].y;
  const candidate = new Float64Array(STRIDE);
  let best = Infinity;
  const options: number[] = [];
  corridorCandidates(link, base, own, options);
  for (let k = 0; k < options.length; k++) {
    const corridor = options[k];
    withCorridor(link.horizontal, shape, 0, corridor, candidate);
    const cost = pathCost(candidate, field.shapes, field.bounds, neighbours, own, best)
      + DEVIATION_COST * Math.abs(corridor - base);
    if (cost < best) best = cost;
  }
  return best;
}
