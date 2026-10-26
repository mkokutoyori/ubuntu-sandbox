import type { CompiledEre } from '@/network/devices/linux/regex/PosixEre';
import type { ColorRule } from './NanoSyntax';
import { wideness } from './NanoText';

export const PAINT_LIMIT = 2000;

export const MULTI = { nothing: 0, wholeLine: 1, justOnThis: 2, startsHere: 3, endsHere: 4 } as const;

export type MultiData = Uint8Array[];

export interface RowWindow {
  readonly fromX: number;
  readonly tillX: number;
  readonly fromCol: number;
  readonly tabsize: number;
  readonly shownColumns: number;
}

export interface PaintedRange {
  readonly from: number;
  readonly to: number;
  readonly rule: ColorRule;
}

interface Found {
  readonly so: number;
  readonly eo: number;
}

function find(regex: CompiledEre, text: string, index: number): Found | null {
  const match = regex.exec(index === 0 ? text : text.slice(index), 0, index > 0);
  return match === null ? null : { so: match.index + index, eo: match.end + index };
}

function stepRight(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff && index + 1 < text.length ? index + 2 : index + 1;
}

export function precalculateMultiData(lines: readonly string[], rules: readonly ColorRule[], multiCount: number): MultiData {
  const data: MultiData = lines.map(() => new Uint8Array(multiCount));
  for (const rule of rules) {
    if (rule.end === null) continue;
    const id = rule.id;
    for (let line = 0; line < lines.length; line++) {
      let index = 0;
      data[line][id] = MULTI.nothing;
      for (;;) {
        const start = find(rule.start, lines[line], index);
        if (start === null) break;
        const startLength = start.eo - start.so;
        index = start.eo;
        const end = find(rule.end, lines[line], index);
        if (end !== null) {
          data[line][id] = MULTI.justOnThis;
          const advanced = end.eo - index;
          index = end.eo;
          if (startLength + advanced === 0) {
            if (index >= lines[line].length) break;
            index = stepRight(lines[line], index);
          }
          continue;
        }
        let tail = line + 1;
        let tailEnd: Found | null = null;
        while (tail < lines.length) {
          tailEnd = find(rule.end, lines[tail], 0);
          if (tailEnd !== null) break;
          tail++;
        }
        data[line][id] = MULTI.startsHere;
        for (let between = line + 1; between < Math.min(tail, lines.length); between++) data[between][id] = MULTI.wholeLine;
        if (tail >= lines.length) {
          line = lines.length - 1;
          break;
        }
        data[tail][id] = MULTI.endsHere;
        line = tail;
        index = tailEnd!.eo;
      }
    }
  }
  return data;
}

export function paintRow(lines: readonly string[], lineIndex: number, rules: readonly ColorRule[], multi: MultiData, window: RowWindow): PaintedRange[] {
  const text = lines[lineIndex];
  const painted: PaintedRange[] = [];
  const previous = lineIndex > 0 ? multi[lineIndex - 1] : null;
  const columnOf = (index: number): number => wideness(text, index, window.tabsize) - window.fromCol;
  for (const rule of rules) {
    if (rule.end === null) {
      let index = 0;
      let startColumn = 0;
      while (index < PAINT_LIMIT && index < window.tillX) {
        const match = find(rule.start, text, index);
        if (match === null) break;
        index = match.eo;
        if (match.so >= window.tillX) break;
        if (match.so === match.eo) {
          if (index >= text.length) break;
          index = stepRight(text, index);
          continue;
        }
        if (match.eo <= window.fromX) continue;
        if (match.so > window.fromX) startColumn = columnOf(match.so);
        painted.push({ from: startColumn, to: columnOf(match.eo), rule });
      }
      continue;
    }
    const states = multi[lineIndex];
    const id = rule.id;
    states[id] = MULTI.nothing;
    let paintedColumns = 0;
    let continuedUntil = 0;
    if (previous !== null && (previous[id] === MULTI.wholeLine || previous[id] === MULTI.startsHere)) {
      const end = find(rule.end, text, 0);
      if (end === null) {
        painted.push({ from: 0, to: window.shownColumns, rule });
        states[id] = MULTI.wholeLine;
        continue;
      }
      if (end.eo > window.fromX) {
        paintedColumns = columnOf(end.eo);
        continuedUntil = end.eo;
        painted.push({ from: 0, to: paintedColumns, rule });
      }
      states[id] = MULTI.endsHere;
    }
    let index = paintedColumns === 0 ? 0 : continuedUntil;
    let startColumn = 0;
    while (index < PAINT_LIMIT) {
      const start = find(rule.start, text, index);
      if (start === null) break;
      if (start.so > window.fromX) startColumn = columnOf(start.so);
      const end = find(rule.end, text, start.eo);
      if (end !== null) {
        if (end.eo > window.fromX && end.eo > start.so) {
          painted.push({ from: startColumn, to: columnOf(end.eo), rule });
          states[id] = MULTI.justOnThis;
        }
        index = end.eo;
        if (start.so === start.eo && end.so === end.eo) {
          if (index >= text.length) break;
          index = stepRight(text, index);
        }
        continue;
      }
      painted.push({ from: startColumn, to: window.shownColumns, rule });
      states[id] = MULTI.startsHere;
      break;
    }
  }
  return painted;
}
