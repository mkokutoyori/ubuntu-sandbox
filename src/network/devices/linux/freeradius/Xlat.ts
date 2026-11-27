import { formatCtime } from '../time/ctime';
import { formatLocalTime } from '../system/SystemInfo';
import { md5Hex, sha1Hex } from '@/crypto/hash';

export const XLAT_FUNCTIONS = new Set(['toupper', 'tolower', 'strlen', 'md5', 'sha1']);

function applyFunction(name: string, argument: string): string {
  if (name === 'toupper') return argument.toUpperCase();
  if (name === 'tolower') return argument.toLowerCase();
  if (name === 'strlen') return String(argument.length);
  if (name === 'md5') return md5Hex(argument);
  return sha1Hex(argument);
}

export type Lookup = (name: string) => string | undefined;

export interface ExternalExpansion {
  escape(value: string): string;
  call(argument: string): string | undefined;
}

export type ExternalExpansions = ReadonlyMap<string, ExternalExpansion>;

export function expandTemplate(template: string, lookup: Lookup, atMs: number, escape: (value: string) => string, externals?: ExternalExpansions): string {
  let out = '';
  for (let index = 0; index < template.length; index++) {
    const char = template[index];
    if (char !== '%') { out += char; continue; }
    const next = template[index + 1];
    if (next === '{') {
      let depth = 1;
      let end = index + 2;
      while (end < template.length && depth > 0) {
        if (template[end] === '{') depth++;
        else if (template[end] === '}') depth--;
        end++;
      }
      const body = template.slice(index + 2, end - 1);
      index = end - 1;
      const alternative = splitAlternative(body);
      if (alternative !== null) {
        const first = expandTemplate(alternative[0], lookup, atMs, escape, externals);
        out += first !== '' ? first : expandTemplate(alternative[1], lookup, atMs, escape, externals);
      } else if (body.startsWith('%{')) out += expandTemplate(body, lookup, atMs, escape, externals);
      else if (externals?.has(/^[A-Za-z0-9_-]+(?=:)/.exec(body)?.[0] ?? '') === true) {
        const colon = body.indexOf(':');
        const external = externals.get(body.slice(0, colon))!;
        out += external.call(expandTemplate(body.slice(colon + 1), lookup, atMs, external.escape, externals)) ?? '';
      } else if (/^(toupper|tolower|strlen|md5|sha1):/.test(body)) {
        const colon = body.indexOf(':');
        out += applyFunction(body.slice(0, colon), expandTemplate(body.slice(colon + 1), lookup, atMs, escape, externals));
      } else {
        const value = lookup(body);
        out += value === undefined ? '' : escape(value);
      }
      continue;
    }
    if (next === 't') { out += formatCtime(new Date(atMs)); index += 1; continue; }
    if (next === '%') { out += '%'; index += 1; continue; }
    if (next !== undefined && /[YmdHMSyejabBAZ]/.test(next)) { out += formatLocalTime(`%${next}`, atMs); index += 1; continue; }
    out += char;
  }
  return out;
}

function splitAlternative(body: string): [string, string] | null {
  let depth = 0;
  for (let index = 0; index < body.length - 1; index++) {
    if (body[index] === '{') depth++;
    else if (body[index] === '}') depth--;
    else if (depth === 0 && body[index] === ':' && body[index + 1] === '-') return [body.slice(0, index), body.slice(index + 2)];
  }
  return null;
}
