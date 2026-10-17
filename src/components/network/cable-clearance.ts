import type { Point } from './connection-line-logic';

export interface ClearanceBox {
  at: Point;
  halfWidth: number;
  halfHeight: number;
}

export interface Clearance {
  hard: number;
  soft: number;
}

export const CLEARANCE_HORIZON = 16;

const CELL = 64;
const OFFSET = 4096;
const SPAN = 8192;

const cellOf = (value: number): number => Math.floor(value / CELL) + OFFSET;
const keyOf = (cx: number, cy: number): number => cx * SPAN + cy;

function pointToBoxDistance(
  px: number, py: number, cx: number, cy: number, halfWidth: number, halfHeight: number,
): number {
  const dx = Math.max(0, Math.abs(px - cx) - halfWidth);
  const dy = Math.max(0, Math.abs(py - cy) - halfHeight);
  return Math.sqrt(dx * dx + dy * dy);
}

export class ClearanceField {
  private readonly segments: number[] = [];
  private readonly owners: number[] = [];
  private readonly segmentCells = new Map<number, number[]>();
  private readonly boxes: ClearanceBox[] = [];
  private readonly boxCells = new Map<number, number[]>();
  private stamp = 0;
  private seen: number[] = [];

  addPolyline(points: ReadonlyArray<Point>, owner: number): void {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const index = this.owners.length;
      this.owners.push(owner);
      this.segments.push(a.x, a.y, b.x, b.y);
      this.enrol(this.segmentCells, index,
        Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
    }
  }

  addBox(box: ClearanceBox): void {
    const index = this.boxes.length;
    this.boxes.push(box);
    this.enrol(this.boxCells, index,
      box.at.x - box.halfWidth, box.at.y - box.halfHeight,
      box.at.x + box.halfWidth, box.at.y + box.halfHeight);
  }

  private enrol(
    cells: Map<number, number[]>, index: number, x0: number, y0: number, x1: number, y1: number,
  ): void {
    const cx1 = cellOf(x1);
    const cy1 = cellOf(y1);
    for (let cx = cellOf(x0); cx <= cx1; cx++) {
      for (let cy = cellOf(y0); cy <= cy1; cy++) {
        const key = keyOf(cx, cy);
        const bucket = cells.get(key);
        if (bucket) bucket.push(index); else cells.set(key, [index]);
      }
    }
  }

  clearance(box: ClearanceBox, owner: number): Clearance {
    const reach = CLEARANCE_HORIZON;
    const x0 = box.at.x - box.halfWidth - reach;
    const x1 = box.at.x + box.halfWidth + reach;
    const y0 = box.at.y - box.halfHeight - reach;
    const y1 = box.at.y + box.halfHeight + reach;
    const cx0 = cellOf(x0), cx1 = cellOf(x1), cy0 = cellOf(y0), cy1 = cellOf(y1);
    let soft = reach;
    let hard = reach;
    const left = box.at.x - box.halfWidth, right = box.at.x + box.halfWidth;
    const top = box.at.y - box.halfHeight, bottom = box.at.y + box.halfHeight;

    this.stamp++;
    const seen = this.seen;
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const key = keyOf(cx, cy);
        const segments = this.segmentCells.get(key);
        if (segments) {
          for (let n = 0; n < segments.length; n++) {
            const index = segments[n];
            if (seen[index] === this.stamp || this.owners[index] === owner) continue;
            seen[index] = this.stamp;
            const s = 4 * index;
            const ax = this.segments[s], ay = this.segments[s + 1], bx = this.segments[s + 2], by = this.segments[s + 3];
            if ((ax < bx ? ax : bx) > right + soft || (ax < bx ? bx : ax) < left - soft
              || (ay < by ? ay : by) > bottom + soft || (ay < by ? by : ay) < top - soft) continue;
            const distance = this.segmentDistance(box, ax, ay, bx, by);
            if (distance < soft) soft = distance;
          }
        }
        const boxes = this.boxCells.get(key);
        if (boxes) {
          for (let n = 0; n < boxes.length; n++) {
            const taken = this.boxes[boxes[n]];
            hard = Math.min(hard, Math.max(
              Math.abs(box.at.x - taken.at.x) - (box.halfWidth + taken.halfWidth),
              Math.abs(box.at.y - taken.at.y) - (box.halfHeight + taken.halfHeight)));
          }
        }
      }
    }
    return { hard, soft };
  }

  private segmentDistance(box: ClearanceBox, ax: number, ay: number, bx: number, by: number): number {
    const vx = bx - ax;
    const vy = by - ay;
    const squared = vx * vx + vy * vy;
    const t = squared === 0
      ? 0
      : Math.max(0, Math.min(1, ((box.at.x - ax) * vx + (box.at.y - ay) * vy) / squared));
    return pointToBoxDistance(ax + vx * t, ay + vy * t, box.at.x, box.at.y, box.halfWidth, box.halfHeight);
  }
}
