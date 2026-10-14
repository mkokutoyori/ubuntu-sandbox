import { sha256 } from '../hash';
import { utf8ToBytes } from '../encoding';
import { cryptBase64 } from './cryptBase64';

export function ciscoType4(password: string): string {
  return cryptBase64(sha256(utf8ToBytes(password)));
}

export function isCiscoType4(value: string): boolean {
  return /^[./0-9A-Za-z]{43}$/.test(value);
}
