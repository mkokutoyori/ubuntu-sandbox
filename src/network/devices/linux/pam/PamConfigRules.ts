import type { PamHandle } from './PamHandle';
import type { LinuxPamHost } from './PamLinuxHost';

export const FIELD_SEPARATOR = ';';
const MAX_FIELD_LENGTH = 1000;

export type ScanState = 'newline' | 'comment' | 'field' | 'eof';

export interface Scanner {
  readonly content: string;
  position: number;
  state: ScanState;
}

export function readField(pamh: PamHandle<LinuxPamHost>, scanner: Scanner): string | null {
  if (scanner.position >= scanner.content.length) {
    scanner.state = 'eof';
    return null;
  }
  let output = '';
  let onSpace = true;
  let index = scanner.position;
  for (; index < scanner.content.length; index++) {
    const character = scanner.content[index];
    if (scanner.state === 'comment' && character !== '\n') continue;
    if (character === '\n') {
      scanner.state = 'newline';
      scanner.position = index + 1;
      return output.replace(/ +$/, '');
    }
    if (character === '\t' || character === ' ') {
      if (!onSpace) {
        onSpace = true;
        output += ' ';
      }
    } else if (character === '!') {
      onSpace = true;
      output += '!';
    } else if (character === '#') {
      scanner.state = 'comment';
    } else if (character === FIELD_SEPARATOR) {
      scanner.state = 'field';
      scanner.position = index + 1;
      return output.replace(/ +$/, '');
    } else if (character === '\\' && scanner.content[index + 1] === '\n') {
      index++;
    } else {
      output += character;
      onSpace = false;
    }
    if (output.length > MAX_FIELD_LENGTH) break;
  }
  scanner.position = scanner.content.length;
  if (scanner.state !== 'comment') {
    scanner.state = 'comment';
    pamh.syslog('err', 'field too long - ignored');
    return '';
  }
  return output.replace(/ +$/, '');
}

function isNameCharacter(character: string): boolean {
  return /[A-Za-z0-9*_\-./:]/.test(character);
}

function logicMember(text: string, atRef: { at: number }): number {
  let to = atRef.at;
  let token = false;
  let done = false;
  while (!done) {
    const character = text[to++] ?? '\0';
    if (character === '\0') {
      to--;
      done = true;
    } else if (character === '&' || character === '|' || character === '!') {
      if (token) to--;
      done = true;
    } else if (isNameCharacter(character)) {
      token = true;
    } else if (token) {
      to--;
      done = true;
    } else {
      atRef.at++;
    }
  }
  return to - atRef.at;
}

export type Agrees = (member: string, rule: number) => boolean;

export function logicField(pamh: PamHandle<LinuxPamHost>, text: string, rule: number, agrees: Agrees): boolean {
  let left = false;
  let negate = false;
  let operator: 'and' | 'or' = 'or';
  let expectValue = true;
  const position = { at: 0 };
  for (;;) {
    const length = logicMember(text, position);
    if (length === 0) break;
    const character = text[position.at] ?? '\0';
    if (expectValue) {
      if (character === '!') negate = !negate;
      else if (isNameCharacter(character)) {
        const right = negate !== agrees(text.slice(position.at, position.at + length), rule);
        left = operator === 'and' ? left && right : left || right;
        expectValue = false;
      } else {
        pamh.syslog('err', `garbled syntax; expected name (rule #${rule})`);
        return false;
      }
    } else {
      if (character === '&') operator = 'and';
      else if (character === '|') operator = 'or';
      else {
        pamh.syslog('err', `garbled syntax; expected & or | (rule #${rule})`);
        return false;
      }
      expectValue = true;
      negate = false;
    }
    position.at += length;
  }
  return left;
}

export function isSame(subject: string, member: string): boolean {
  let length = member.length;
  let index = 0;
  for (; length > 0; index++, length--) {
    if (member[index] !== subject[index]) {
      if (member[index++] === '*') {
        length--;
        return length === 0 || member.slice(index, index + length) === subject.slice(subject.length - length);
      }
      return false;
    }
  }
  if (index < subject.length) return false;
  return length === 0;
}

const DAYS: ReadonlyArray<readonly [string, number]> = [
  ['su', 0o1], ['mo', 0o2], ['tu', 0o4], ['we', 0o10], ['th', 0o20], ['fr', 0o40], ['sa', 0o100],
  ['wk', 0o76], ['wd', 0o101], ['al', 0o177],
];

export const WEEKDAY_BITS = [0o1, 0o2, 0o4, 0o10, 0o20, 0o40, 0o100];

export interface ClockNow {
  readonly day: number;
  readonly minute: number;
}

export function checkTime(pamh: PamHandle<LinuxPamHost>, now: ClockNow, times: string, rule: number): boolean {
  let length = times.length;
  let cursor = 0;
  let negate = false;
  if (times[cursor] === '!') {
    cursor++;
    negate = true;
  }
  let markedDay = 0;
  for (; length > 0 && /[A-Za-z]/.test(times[cursor] ?? ''); length--) {
    const wanted = `${(times[cursor] ?? '').toLowerCase()}${(times[cursor + 1] ?? '').toLowerCase()}`;
    const found = DAYS.find(([name]) => name === wanted);
    cursor += 2;
    if (found === undefined) {
      pamh.syslog('err', `bad day specified (rule #${rule})`);
      return false;
    }
    markedDay ^= found[1];
  }
  if (markedDay === 0) {
    pamh.syslog('err', 'no day specified');
    return false;
  }
  let timeStart = 0;
  let digits = 0;
  for (; length > 0 && digits < 4 && /[0-9]/.test(times[digits + cursor] ?? ''); digits++, length--) {
    timeStart = timeStart * 10 + (times.charCodeAt(digits + cursor) - 48);
  }
  cursor += digits;
  let timeEnd = -1;
  let consumed = digits;
  if (times[cursor] === '-') {
    timeEnd = 0;
    consumed = 1;
    for (; length > 0 && consumed < 5 && /[0-9]/.test(times[consumed + cursor] ?? ''); consumed++, length--) {
      timeEnd = timeEnd * 10 + (times.charCodeAt(consumed + cursor) - 48);
    }
    cursor += consumed;
  }
  if (consumed !== 5 || timeEnd === -1) {
    pamh.syslog('err', `no/bad times specified (rule #${rule})`);
    return true;
  }
  let pass = false;
  if (timeStart < timeEnd) {
    pass = (now.day & markedDay) !== 0 && now.minute >= timeStart && now.minute < timeEnd;
  } else if ((now.day & markedDay) !== 0 && now.minute >= timeStart) {
    pass = true;
  } else {
    markedDay <<= 1;
    markedDay |= (markedDay & 0o200) !== 0 ? 1 : 0;
    pass = (now.day & markedDay) !== 0 && now.minute <= timeEnd;
  }
  return negate !== pass;
}


export function clockNow(pamh: PamHandle<LinuxPamHost>): ClockNow {
  const local = pamh.host.localTime(pamh.host.now());
  return { day: WEEKDAY_BITS[local.weekday], minute: local.hour * 100 + local.minute };
}

export function ttyName(pamh: PamHandle<LinuxPamHost>): string {
  let tty = pamh.tty ?? '';
  if (pamh.tty === null) pamh.tty = '';
  if (tty.startsWith('/')) {
    tty = tty.slice(1);
    const slash = tty.indexOf('/');
    if (slash >= 0) tty = tty.slice(slash + 1);
  }
  return tty;
}
