import { decodeFacilityName, decodeSeverityName } from '../config/Filters';
import type { DirectiveRegistration, InputContext } from './Modules';

const SIZE_SUFFIX: Readonly<Record<string, number>> = {
  k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5, e: 1024 ** 6,
  K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4, P: 1000 ** 5, E: 1000 ** 6,
};

export interface DirectiveEnvironment {
  readonly context: InputContext;
  report(message: string): void;
  warn(message: string): void;
  uidOf(name: string): number | null;
  gidOf(name: string): number | null;
  unresolvedId(message: string): void;
}

function skipSpaces(text: string, position: number): number {
  let index = position;
  while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index++;
  return index;
}

function readWord(text: string, position: number): { word: string; next: number } {
  let index = skipSpaces(text, position);
  const start = index;
  while (index < text.length && text[index] !== ' ' && text[index] !== '\t') index++;
  return { word: text.slice(start, index), next: index };
}

function readInteger(text: string, position: number): { value: number; next: number } | null {
  let index = skipSpaces(text, position);
  const start = index;
  if (text[index] === '-') index++;
  const digitsStart = index;
  while (index < text.length && text[index] >= '0' && text[index] <= '9') index++;
  if (index === digitsStart) return null;
  return { value: Number.parseInt(text.slice(start, index), 10), next: index };
}

export function applyDirective(registration: DirectiveRegistration, rest: string, env: DirectiveEnvironment): string | null {
  const text = rest;
  switch (registration.type) {
    case 'binary': {
      const start = skipSpaces(text, 0);
      const word = readWord(text, start);
      if (word.word === 'on') registration.apply(1, env.context);
      else if (word.word === 'off') registration.apply(0, env.context);
      else {
        env.report(`Option value must be on or off, but is '${text.slice(start)}'`);
        return null;
      }
      return text.slice(word.next);
    }
    case 'int':
    case 'nonneg':
    case 'positive': {
      const parsed = readInteger(text, 0);
      if (parsed === null) {
        env.report('invalid number');
        return null;
      }
      if (registration.type === 'nonneg' && parsed.value < 0) {
        env.report(`value ${parsed.value} for config command is less than zero`);
        return null;
      }
      if (registration.type === 'positive' && parsed.value < 1) {
        env.report(`value ${parsed.value} for config command is less than one`);
        return null;
      }
      registration.apply(parsed.value, env.context);
      return text.slice(parsed.next);
    }
    case 'size': {
      const parsed = readInteger(text, 0);
      if (parsed === null) {
        env.report('invalid number');
        return null;
      }
      let value = parsed.value;
      let next = parsed.next;
      const multiplier = SIZE_SUFFIX[text[next]];
      if (multiplier !== undefined) {
        value *= multiplier;
        next++;
      }
      registration.apply(value, env.context);
      return text.slice(next);
    }
    case 'word':
    case 'char': {
      const word = readWord(text, 0);
      registration.apply(word.word, env.context);
      return text.slice(word.next);
    }
    case 'facility':
    case 'severity': {
      const word = readWord(text, 0);
      registration.apply(registration.type === 'facility' ? decodeFacilityName(word.word) : decodeSeverityName(word.word), env.context);
      return text.slice(word.next);
    }
    case 'uid':
    case 'gid': {
      const word = readWord(text, 0);
      const id = registration.type === 'uid' ? env.uidOf(word.word) : env.gidOf(word.word);
      if (id === null) {
        env.unresolvedId(registration.type === 'uid' ? `ID for user '${word.word}' could not be found or error` : `ID for group '${word.word}' could not be found or error`);
        return text.slice(word.next);
      }
      registration.apply(id, env.context);
      return text.slice(word.next);
    }
    case 'filemode': {
      const word = readWord(text, 0);
      if (!/^0[0-7]{3,4}$/.test(word.word)) {
        env.report(`value ${word.word} for config command is not a file creation mode`);
        return text.slice(word.next);
      }
      registration.apply(Number.parseInt(word.word, 8), env.context);
      return text.slice(word.next);
    }
    case 'goneaway':
      env.warn('config directive is no longer supported -- ignored');
      return text;
    default:
      return registration.custom === undefined ? text : registration.custom(text, env.context);
  }
}
