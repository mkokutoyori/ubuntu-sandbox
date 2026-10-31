import { implicitToDate } from '@/database/oracle/functions/valueUtils';

const MS_PER_DAY = 86_400_000;

export interface CompletedWindow {
  readonly after: number;
  readonly before: number;
}

const QUOTED = `(?:'([^']*)'|"([^"]*)")`;
const ONE_BOUND = new RegExp(`^COMPLETED\\s+(AFTER|BEFORE)\\s+${QUOTED}$`, 'i');
const TWO_BOUNDS = new RegExp(`^COMPLETED\\s+BETWEEN\\s+${QUOTED}\\s+AND\\s+${QUOTED}$`, 'i');

export function parseRmanTime(raw: string, nowMs: number): number | null {
  const text = raw.replace(/^['"]|['"]$/g, '').trim();
  const relative = text.match(/^SYSDATE(?:\s*([+-])\s*(\d+(?:\.\d+)?))?$/i);
  if (relative) {
    const days = relative[2] === undefined ? 0 : Number(relative[2]);
    return nowMs + (relative[1] === '-' ? -days : days) * MS_PER_DAY;
  }
  return implicitToDate(text)?.getTime() ?? null;
}

export function parseCompletedClause(clause: string, nowMs: number): CompletedWindow | null {
  const text = clause.trim();
  const between = TWO_BOUNDS.exec(text);
  if (between !== null) {
    const from = parseRmanTime(between[1] ?? between[2], nowMs);
    const to = parseRmanTime(between[3] ?? between[4], nowMs);
    return from === null || to === null ? null : { after: from, before: to };
  }
  const single = ONE_BOUND.exec(text);
  if (single === null) return null;
  const bound = parseRmanTime(single[2] ?? single[3], nowMs);
  if (bound === null) return null;
  return single[1].toUpperCase() === 'AFTER'
    ? { after: bound, before: Infinity }
    : { after: -Infinity, before: bound };
}

export function completedWithin(window: CompletedWindow, completionMs: number): boolean {
  return completionMs >= window.after && completionMs <= window.before;
}
