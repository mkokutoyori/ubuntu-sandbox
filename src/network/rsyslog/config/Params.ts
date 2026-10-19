import { decodeFacilityName, decodeSeverityName } from './Filters';
import type { NvEntry, NvList } from './Ast';

export type ParamType =
  | 'string' | 'binary' | 'int' | 'nonneg' | 'positive' | 'size' | 'word' | 'array' | 'char' | 'facility' | 'severity'
  | 'queuetype' | 'uid' | 'gid' | 'filemode' | 'goneaway';

export interface ParamDescriptor {
  readonly name: string;
  readonly type: ParamType;
  readonly required?: boolean;
  readonly deprecated?: boolean;
}

export type ParamValue =
  | { readonly kind: 'S'; readonly s: string }
  | { readonly kind: 'N'; readonly n: number }
  | { readonly kind: 'A'; readonly a: string[] };

export type ParamValues = Map<string, ParamValue>;

export interface ParamEnvironment {
  report(message: string): void;
  uidOf(name: string): number | null;
  gidOf(name: string): number | null;
}

export const QUEUE_TYPES: Readonly<Record<string, string>> = {
  fixedarray: 'FixedArray', linkedlist: 'LinkedList', disk: 'Disk', direct: 'Direct', segmenteddisk: 'SegmentedDisk',
};

const SIZE_SUFFIX: Readonly<Record<string, number>> = {
  k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5, e: 1024 ** 6,
  K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4, P: 1000 ** 5, E: 1000 ** 6,
};

function parseInteger(text: string): { n: number; ok: boolean } {
  if (text.length === 0) return { n: 0, ok: true };
  let index = 0;
  let sign = 1;
  if (text[0] === '-') {
    sign = -1;
    index = 1;
  }
  let value = 0;
  while (index < text.length && text[index] >= '0' && text[index] <= '9') {
    value = value * 10 + (text.charCodeAt(index) - 48);
    index++;
  }
  return { n: value * sign, ok: index === text.length };
}

function parseOne(entry: NvEntry, descriptor: ParamDescriptor, env: ParamEnvironment): ParamValue | null {
  const { name } = descriptor;
  if (Array.isArray(entry.value) && descriptor.type !== 'array') {
    env.report(`parameter '${name}' is not a string, which is not permitted`);
    return null;
  }
  entry.used = true;
  const text = Array.isArray(entry.value) ? '' : entry.value;
  switch (descriptor.type) {
    case 'array':
      return { kind: 'A', a: Array.isArray(entry.value) ? [...entry.value] : [entry.value] };
    case 'binary':
      if (text === 'on') return { kind: 'N', n: 1 };
      if (text === 'off') return { kind: 'N', n: 0 };
      env.report(`parameter '${name}' must be "on" or "off" but is neither. Results unpredictable.`);
      return null;
    case 'int':
    case 'nonneg':
    case 'positive': {
      const parsed = parseInteger(text);
      if (!parsed.ok) {
        env.report(`parameter '${name}' is not a proper number`);
        return null;
      }
      if (descriptor.type === 'nonneg' && parsed.n < 0) {
        env.report(`parameter '${name}' cannot be less than zero (was ${parsed.n})`);
        return null;
      }
      if (descriptor.type === 'positive' && parsed.n < 1) {
        env.report(`parameter '${name}' cannot be less than one (was ${parsed.n})`);
        return null;
      }
      return { kind: 'N', n: parsed.n };
    }
    case 'size': {
      let index = 0;
      let value = 0;
      while (index < text.length && text[index] >= '0' && text[index] <= '9') value = value * 10 + (text.charCodeAt(index++) - 48);
      if (index < text.length) {
        const multiplier = SIZE_SUFFIX[text[index]];
        if (multiplier === undefined) {
          env.report(`parameter '${name}' does not contain a valid size`);
          return null;
        }
        value *= multiplier;
        index++;
        if (index < text.length) {
          env.report(`parameter '${name}' does not contain a valid size`);
          return null;
        }
      }
      return { kind: 'N', n: value };
    }
    case 'word': {
      const word = /^\S*/.exec(text)?.[0] ?? '';
      if (word.length !== text.length) {
        env.report(`parameter '${name}' contains whitespace, which is not permitted`);
        return null;
      }
      return { kind: 'S', s: word };
    }
    case 'char':
      if (text.length !== 1) {
        env.report(`parameter '${name}' must contain exactly one character but contains ${text.length} - cannot be processed`);
        return { kind: 'S', s: text };
      }
      return { kind: 'S', s: text };
    case 'facility': return { kind: 'N', n: decodeFacilityName(text) };
    case 'severity': return { kind: 'N', n: decodeSeverityName(text) };
    case 'queuetype': {
      const found = QUEUE_TYPES[text.toLowerCase()];
      if (found === undefined) {
        env.report(`param '${name}': unknown queue type: '${text}'`);
        return null;
      }
      return { kind: 'S', s: found };
    }
    case 'filemode': {
      const ok = text.length >= 4 && text[0] === '0' && /^[0-7]{3}$/.test(text.slice(1, 4)) && (text.length === 4 || (text.length === 5 && /[0-7]/.test(text[4])));
      if (!ok) {
        env.report(`file modes need to be specified as 4- or 5-digit octal numbers starting with '0' -parameter '${name}="${text}"' is not a file mode`);
        return null;
      }
      return { kind: 'N', n: Number.parseInt(text, 8) };
    }
    case 'uid': {
      const uid = env.uidOf(text);
      if (uid === null) {
        env.report(`parameter '${name}': ID for user '${text}' could not be found: No such file or directory`);
        return null;
      }
      return { kind: 'N', n: uid };
    }
    case 'gid': {
      const gid = env.gidOf(text);
      if (gid === null) {
        env.report(`parameter '${name}': ID for group ${text} could not be found`);
        return null;
      }
      return { kind: 'N', n: gid };
    }
    case 'goneaway':
      env.report(`parameter '${name}' is no longer supported`);
      return { kind: 'N', n: 0 };
    default: return { kind: 'S', s: text };
  }
}

export function getParams(list: NvList, block: readonly ParamDescriptor[], env: ParamEnvironment): ParamValues | null {
  const values: ParamValues = new Map();
  let failed = false;
  for (const descriptor of block) {
    const entry = list.find(descriptor.name);
    if (entry === undefined) {
      if (descriptor.required === true) {
        env.report(`parameter '${descriptor.name}' required but not specified - fix config`);
        failed = true;
      }
      continue;
    }
    if (descriptor.deprecated === true) {
      env.report(`parameter '${descriptor.name}' deprecated but accepted, consider removing or replacing it`);
    }
    const value = parseOne(entry, descriptor, env);
    if (value === null) failed = true;
    else values.set(descriptor.name, value);
  }
  return failed ? null : values;
}

export function reportUnused(list: NvList, report: (message: string) => void): void {
  for (const entry of list.unused()) report(`parameter '${entry.name}' not known -- typo in config file?`);
}

export function reportDuplicates(list: NvList, report: (message: string) => void): void {
  list.entries.forEach((entry, index) => {
    const wanted = entry.name.toLowerCase();
    if (list.entries.slice(index + 1).some((other) => other.name.toLowerCase() === wanted)) {
      report(`duplicate parameter '${entry.name}' -- interpretation is ambiguous, one value will be randomly selected. Fix this problem.`);
    }
  });
}

export function isDisabled(list: NvList): boolean {
  const entry = list.find('config.enabled');
  if (entry === undefined) return false;
  entry.used = true;
  return Array.isArray(entry.value) || entry.value !== 'on';
}

export function stringParam(values: ParamValues, name: string): string | undefined {
  const value = values.get(name);
  return value?.kind === 'S' ? value.s : undefined;
}

export function numberParam(values: ParamValues, name: string): number | undefined {
  const value = values.get(name);
  return value?.kind === 'N' ? value.n : undefined;
}

export function arrayParam(values: ParamValues, name: string): string[] | undefined {
  const value = values.get(name);
  return value?.kind === 'A' ? value.a : undefined;
}
