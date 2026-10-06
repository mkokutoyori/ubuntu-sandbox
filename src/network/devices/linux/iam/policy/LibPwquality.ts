import { PasswordQualityRule } from './PasswordQualityResult';

export const PWQ_MIN_WORD_LENGTH = 4;
export const PWQ_DEFAULT_DIF_OK = 1;
const PWQ_NUM_CLASSES = 4;

export interface PwqualitySettings {
  readonly difOk: number;
  readonly minLength: number;
  readonly digitCredit: number;
  readonly uppercaseCredit: number;
  readonly lowercaseCredit: number;
  readonly otherCredit: number;
  readonly minClasses: number;
  readonly maxRepeat: number;
  readonly maxClassRepeat: number;
  readonly maxSequence: number;
  readonly gecosCheck: boolean;
  readonly userCheck: boolean;
  readonly userSubstr: number;
  readonly dictCheck: boolean;
  readonly badWords: readonly string[];
  readonly dictionaryWords: readonly string[];
}

export interface PwqualityFailure {
  readonly rule: PasswordQualityRule;
  readonly message: string;
}

export type PwqualityVerdict =
  | { readonly ok: true; readonly score: number }
  | { readonly ok: false; readonly failure: PwqualityFailure };

const encoder = new TextEncoder();

function bytesOf(text: string): number[] {
  return [...encoder.encode(text)];
}

function lowered(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

function isUpper(byte: number): boolean {
  return byte >= 0x41 && byte <= 0x5a;
}

function isLower(byte: number): boolean {
  return byte >= 0x61 && byte <= 0x7a;
}

function palindrome(text: string): boolean {
  const bytes = bytesOf(text);
  const length = bytes.length;
  for (let index = 0; index < length; index++) {
    if (bytes[length - index - 1] !== bytes[index]) return false;
  }
  return true;
}

function distance(old: string, fresh: string): number {
  const oldBytes = bytesOf(old);
  const newBytes = bytesOf(fresh);
  const m = oldBytes.length;
  const n = newBytes.length;
  const differs = (i: number, j: number): number => {
    const c = i === 0 || oldBytes.length < i ? 0 : oldBytes[i - 1];
    const d = j === 0 || newBytes.length < j ? 0 : newBytes[j - 1];
    return c !== d ? 1 : 0;
  };
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(-1));
  for (let i = 0; i <= m; i++) table[i][0] = i;
  for (let j = 0; j <= n; j++) table[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      table[i][j] = Math.min(table[i - 1][j - 1], table[i][j - 1], table[i - 1][j]) + differs(i, j);
    }
  }
  return table[m][n];
}

function similar(settings: PwqualitySettings, old: string, fresh: string): boolean {
  if (distance(old, fresh) >= settings.difOk) return false;
  return bytesOf(fresh).length < bytesOf(old).length * 2;
}

function numClass(password: string): number {
  let digits = 0;
  let uppers = 0;
  let lowers = 0;
  let others = 0;
  for (const byte of bytesOf(password)) {
    if (isDigit(byte)) digits = 1;
    else if (isUpper(byte)) uppers = 1;
    else if (isLower(byte)) lowers = 1;
    else others = 1;
  }
  return digits + uppers + lowers + others;
}

function simple(settings: PwqualitySettings, password: string): PwqualityFailure | null {
  let digits = 0;
  let uppers = 0;
  let lowers = 0;
  let others = 0;
  type ClassName = 'none' | 'digit' | 'upper' | 'lower' | 'other';
  let previous: ClassName = 'none';
  let sameClass = 0;
  const bytes = bytesOf(password);
  for (const byte of bytes) {
    let current: ClassName;
    if (isDigit(byte)) { digits++; current = 'digit'; }
    else if (isUpper(byte)) { uppers++; current = 'upper'; }
    else if (isLower(byte)) { lowers++; current = 'lower'; }
    else { others++; current = 'other'; }
    sameClass = current === previous ? sameClass + 1 : 1;
    previous = current;
    if (settings.maxClassRepeat > 1 && sameClass > settings.maxClassRepeat) {
      return {
        rule: PasswordQualityRule.MaxClassRepeat,
        message: `The password contains more than ${settings.maxClassRepeat} characters of the same class consecutively`,
      };
    }
  }
  if (settings.digitCredit >= 0 && digits > settings.digitCredit) digits = settings.digitCredit;
  if (settings.uppercaseCredit >= 0 && uppers > settings.uppercaseCredit) uppers = settings.uppercaseCredit;
  if (settings.lowercaseCredit >= 0 && lowers > settings.lowercaseCredit) lowers = settings.lowercaseCredit;
  if (settings.otherCredit >= 0 && others > settings.otherCredit) others = settings.otherCredit;
  let size = settings.minLength;
  if (settings.digitCredit >= 0) size -= digits;
  else if (digits < -settings.digitCredit) {
    return { rule: PasswordQualityRule.MinDigits, message: `The password contains less than ${-settings.digitCredit} digits` };
  }
  if (settings.uppercaseCredit >= 0) size -= uppers;
  else if (uppers < -settings.uppercaseCredit) {
    return { rule: PasswordQualityRule.MinUppercase, message: `The password contains less than ${-settings.uppercaseCredit} uppercase letters` };
  }
  if (settings.lowercaseCredit >= 0) size -= lowers;
  else if (lowers < -settings.lowercaseCredit) {
    return { rule: PasswordQualityRule.MinLowercase, message: `The password contains less than ${-settings.lowercaseCredit} lowercase letters` };
  }
  if (settings.otherCredit >= 0) size -= others;
  else if (others < -settings.otherCredit) {
    return { rule: PasswordQualityRule.MinOther, message: `The password contains less than ${-settings.otherCredit} non-alphanumeric characters` };
  }
  if (size <= bytes.length) return null;
  return { rule: PasswordQualityRule.MinLength, message: `The password is shorter than ${size} characters` };
}

function consecutive(settings: PwqualitySettings, password: string): boolean {
  if (settings.maxRepeat === 0) return false;
  let previous = -1;
  let same = 0;
  let first = true;
  for (const byte of bytesOf(password)) {
    if (!first && byte === previous) {
      same++;
      if (same > settings.maxRepeat) return true;
    } else {
      previous = byte;
      same = 1;
    }
    first = false;
  }
  return false;
}

function sequence(settings: PwqualitySettings, password: string): boolean {
  if (settings.maxSequence === 0) return false;
  const bytes = bytesOf(password);
  if (bytes.length === 0) return false;
  let up = 1;
  let down = 1;
  for (let index = 1; index < bytes.length; index++) {
    const previous = bytes[index - 1];
    if (bytes[index] === previous + 1) {
      up++;
      if (up > settings.maxSequence) return true;
      down = 1;
    } else if (bytes[index] === previous - 1) {
      down++;
      if (down > settings.maxSequence) return true;
      up = 1;
    } else {
      up = 1;
      down = 1;
    }
  }
  return false;
}

function wordCheck(fresh: string, word: string): boolean {
  if (bytesOf(word).length < PWQ_MIN_WORD_LENGTH) return false;
  if (fresh.includes(word)) return true;
  let measured = distance(fresh, word);
  if (measured >= 0 && measured < PWQ_DEFAULT_DIF_OK) return true;
  const reversed = [...word].reverse().join('');
  if (fresh.includes(reversed)) return true;
  measured = distance(fresh, reversed);
  return measured >= 0 && measured < PWQ_DEFAULT_DIF_OK;
}

function userCheck(settings: PwqualitySettings, fresh: string, user: string): boolean {
  const length = user.length;
  if (settings.userSubstr >= PWQ_MIN_WORD_LENGTH && length > settings.userSubstr) {
    for (let offset = 0; offset <= length - settings.userSubstr; offset++) {
      if (wordCheck(fresh, user.slice(offset, offset + settings.userSubstr))) return true;
    }
    return false;
  }
  return wordCheck(fresh, user);
}

function wordListCheck(fresh: string, wordList: string): boolean {
  for (const word of wordList.split(' ')) {
    if (bytesOf(word).length >= PWQ_MIN_WORD_LENGTH && wordCheck(fresh, lowered(word))) return true;
  }
  return false;
}

function score(settings: PwqualitySettings, password: string): number {
  const buffer = bytesOf(password);
  const length = buffer.length;
  let total = (length - settings.minLength) * 2;
  for (let round = 0; round < 3; round++) {
    const frequencies = new Array<number>(256).fill(0);
    for (let index = 0; index < length - round; index++) {
      frequencies[buffer[index]]++;
      if (index < length - round - 1) buffer[index] = Math.abs(buffer[index] - buffer[index + 1]);
    }
    total += frequencies.filter((count) => count > 0).length;
  }
  total += numClass(password) * 2;
  total = Math.trunc((total * 100) / (3 * settings.minLength + PWQ_NUM_CLASSES * 2));
  total -= 50;
  return Math.max(0, Math.min(100, total));
}

function fail(rule: PasswordQualityRule, message: string): PwqualityVerdict {
  return { ok: false, failure: { rule, message } };
}

export function pwqualityCheck(
  settings: PwqualitySettings,
  password: string,
  oldPassword: string | null,
  user: string | null,
  gecos: string | null,
): PwqualityVerdict {
  if (password === '') return fail(PasswordQualityRule.Empty, 'No password supplied');
  const account = user === '' ? null : user;
  let old = oldPassword === '' ? null : oldPassword;
  if (old !== null && old === password) return fail(PasswordQualityRule.SamePassword, 'The password is the same as the old one');
  if (settings.difOk === 0) old = null;

  const freshMono = lowered(password);
  const oldMono = old === null ? null : lowered(old);
  const userMono = account === null ? null : lowered(account);
  if (palindrome(freshMono)) return fail(PasswordQualityRule.Palindrome, 'The password is a palindrome');
  if (oldMono !== null && oldMono === freshMono) return fail(PasswordQualityRule.CaseChangesOnly, 'The password differs with case changes only');
  if (oldMono !== null && similar(settings, oldMono, freshMono)) {
    return fail(PasswordQualityRule.TooSimilar, 'The password is too similar to the old one');
  }
  const simpleFailure = simple(settings, password);
  if (simpleFailure !== null) return { ok: false, failure: simpleFailure };
  if (oldMono !== null && (oldMono + oldMono).includes(freshMono)) {
    return fail(PasswordQualityRule.Rotated, 'The password is just rotated old one');
  }
  if (numClass(password) < settings.minClasses) {
    return fail(PasswordQualityRule.MinClasses, `The password contains less than ${settings.minClasses} character classes`);
  }
  if (consecutive(settings, password)) {
    return fail(PasswordQualityRule.MaxRepeat, `The password contains more than ${settings.maxRepeat} same characters consecutively`);
  }
  if (sequence(settings, password)) {
    return fail(PasswordQualityRule.MaxSequence, `The password contains monotonic sequence longer than ${settings.maxSequence} characters`);
  }
  if (userMono !== null && settings.userCheck && userCheck(settings, freshMono, userMono)) {
    return fail(PasswordQualityRule.ContainsUsername, 'The password contains the user name in some form');
  }
  if (account !== null && settings.gecosCheck && gecos !== null && wordListCheck(freshMono, gecos)) {
    return fail(PasswordQualityRule.ContainsGecos, 'The password contains words from the real name of the user in some form');
  }
  if (settings.badWords.length > 0 && wordListCheck(freshMono, settings.badWords.join(' '))) {
    return fail(PasswordQualityRule.BadWords, 'The password contains forbidden words in some form');
  }
  if (settings.dictCheck && settings.dictionaryWords.some((word) => freshMono === word || freshMono.startsWith(word))) {
    return fail(PasswordQualityRule.DictionaryWord, 'The password fails the dictionary check - it is based on a dictionary word');
  }
  return { ok: true, score: score(settings, password) };
}
