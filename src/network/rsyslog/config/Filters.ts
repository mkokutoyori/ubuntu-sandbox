import { describeProperty } from '../Properties';
import type { PropertyFilterOperation } from './Ast';

export const FACILITY_SLOTS = 25;
export const TABLE_NOPRI = 0;
export const TABLE_ALLPRI = 0xff;
export const INTERNAL_NOPRI = 0x10;

const PRIORITY_NAMES: Readonly<Record<string, number>> = {
  alert: 1, crit: 2, debug: 7, emerg: 0, err: 3, error: 3, info: 6, none: INTERNAL_NOPRI, notice: 5, panic: 0, warn: 4,
  warning: 4, '*': TABLE_ALLPRI,
};

const FACILITY_CODES: Readonly<Record<string, number>> = {
  auth: 4 << 3, authpriv: 10 << 3, cron: 9 << 3, daemon: 3 << 3, kern: 0, lpr: 6 << 3, mail: 2 << 3, mark: 24 << 3,
  news: 7 << 3, ntp: 12 << 3, security: 4 << 3, bsd_security: 13 << 3, syslog: 5 << 3, user: 1 << 3, uucp: 8 << 3,
  ftp: 11 << 3, audit: 13 << 3, console: 14 << 3, local0: 16 << 3, local1: 17 << 3, local2: 18 << 3, local3: 19 << 3,
  local4: 20 << 3, local5: 21 << 3, local6: 22 << 3, local7: 23 << 3,
};

function decodeName(name: string, table: Readonly<Record<string, number>>): number {
  if (name.length > 0 && name[0] >= '0' && name[0] <= '9') {
    return /^\d+$/.test(name) ? Number.parseInt(name, 10) : -1;
  }
  const folded = name.slice(0, 79).toLowerCase();
  return Object.prototype.hasOwnProperty.call(table, folded) ? table[folded] : -1;
}

export function decodeFacilityName(name: string): number {
  return decodeName(name, FACILITY_CODES);
}

export function decodeSeverityName(name: string): number {
  return decodeName(name, PRIORITY_NAMES);
}

export function emptyPriorityMask(): number[] {
  return new Array<number>(FACILITY_SLOTS).fill(TABLE_NOPRI);
}

export type FilterDiagnostic = (message: string) => void;

export function decodePriorityFilter(line: string, report: FilterDiagnostic): number[] | null {
  const mask = emptyPriorityMask();
  const isStop = (character: string, set: string): boolean => set.includes(character);
  let p = 0;
  while (p < line.length && line[p] !== '\t' && line[p] !== ' ') {
    let q = p;
    while (q < line.length && line[q] !== '\t') {
      const consumed = line[q++];
      if (consumed === '.') break;
    }
    let buffer = '';
    while (q < line.length && !isStop(line[q], '\t ,;') && buffer.length < 2047) buffer += line[q++];
    if (q < line.length) while (q < line.length && isStop(line[q], ',;')) q++;

    let ignore = false;
    if (buffer[0] === '!') {
      ignore = true;
      buffer = buffer.slice(1);
    }
    let single = false;
    let priority: number;
    if (buffer[0] === '=') {
      single = true;
      priority = decodeSeverityName(buffer.slice(1));
    } else {
      priority = decodeSeverityName(buffer);
    }
    if (priority < 0) {
      report(`unknown priority name "${buffer}"`);
      return null;
    }

    while (p < line.length && !isStop(line[p], '\t .;')) {
      let name = '';
      while (p < line.length && !isStop(line[p], '\t ,;.') && name.length < 2047) name += line[p++];
      const apply = (slot: number): void => {
        if (priority === INTERNAL_NOPRI) {
          mask[slot] = ignore ? TABLE_ALLPRI : TABLE_NOPRI;
        } else if (single) {
          if (ignore) {
            if (mask[slot] === TABLE_NOPRI) mask[slot] = TABLE_ALLPRI;
            mask[slot] &= ~(1 << priority);
          } else mask[slot] |= 1 << priority;
        } else if (priority === TABLE_ALLPRI) {
          mask[slot] = ignore ? TABLE_NOPRI : TABLE_ALLPRI;
        } else if (ignore) {
          if (mask[slot] === TABLE_NOPRI) mask[slot] = TABLE_ALLPRI;
          for (let level = 0; level <= priority; level++) mask[slot] &= ~(1 << level);
        } else {
          for (let level = 0; level <= priority; level++) mask[slot] |= 1 << level;
        }
        mask[slot] &= 0xff;
      };
      if (name[0] === '*') {
        for (let slot = 0; slot < FACILITY_SLOTS; slot++) apply(slot);
      } else {
        const facility = decodeFacilityName(name);
        if (facility < 0) {
          report(`unknown facility name "${name}"`);
          return null;
        }
        apply(facility >> 3);
      }
      while (line[p] === ',' || line[p] === ' ') p++;
    }
    p = q;
  }
  return mask;
}

export function priorityMaskMatches(mask: readonly number[], facility: number, severity: number): boolean {
  const slot = mask[facility] ?? TABLE_NOPRI;
  return slot !== TABLE_NOPRI && (slot & (1 << severity)) !== 0;
}

export interface DecodedPropertyFilter {
  readonly prop: ReturnType<typeof describeProperty>;
  readonly operation: PropertyFilterOperation;
  readonly negated: boolean;
  readonly value: string;
}

const OPERATIONS: readonly PropertyFilterOperation[] = ['contains', 'isequal', 'isempty', 'startswith', 'endswith', 'regex', 'ereregex'];

function readDelimited(source: string, start: number, delimiter: string): { text: string; next: number } | null {
  let position = start;
  while (position < source.length && (source[position] === ' ' || source[position] === '\t')) position++;
  let text = '';
  while (position < source.length && source[position] !== delimiter) text += source[position++].toLowerCase();
  if (position >= source.length && text.length === 0) return null;
  if (source[position] === delimiter) position++;
  return { text: text.replace(/[ \t]+$/, ''), next: position };
}

export function decodePropertyFilter(line: string, report: FilterDiagnostic): DecodedPropertyFilter | null {
  const body = line.slice(1);
  const property = readDelimited(body, 0, ',');
  if (property === null) {
    report('error 1 parsing filter property');
    return null;
  }
  const prop = describeProperty(property.text);
  if (prop.id === 'invalid') report(`invalid property '${property.text}'`);
  const operationRead = readDelimited(body, property.next, ',');
  if (operationRead === null) {
    report('error compare operation property - ignoring selector');
    return null;
  }
  let word = operationRead.text;
  let negated = false;
  if (word.length > 0 && word[0] === '!') {
    negated = true;
    word = word.slice(1);
  }
  const operation = OPERATIONS.find((candidate) => candidate === word);
  if (operation === undefined) {
    report(`error: invalid compare operation '${operationRead.text}'`);
    return null;
  }
  let value = '';
  if (operation !== 'isempty') {
    let position = body.indexOf('"', operationRead.next);
    if (position < 0) {
      report('error 1 compare value property');
      return null;
    }
    position++;
    let closed = false;
    while (position < body.length) {
      const character = body[position];
      if (character === '\\' && position + 1 < body.length) {
        value += body[position + 1];
        position += 2;
        continue;
      }
      if (character === '"') {
        closed = true;
        break;
      }
      value += character;
      position++;
    }
    if (!closed) {
      report('error 1 compare value property');
      return null;
    }
  }
  return { prop, operation, negated, value };
}
