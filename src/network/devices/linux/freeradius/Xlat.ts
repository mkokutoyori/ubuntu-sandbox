import { formatCtime } from '../time/ctime';
import { formatLocalTime } from '../system/SystemInfo';

export type Lookup = (name: string) => string | undefined;

export function expandTemplate(template: string, lookup: Lookup, atMs: number, escape: (value: string) => string): string {
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
        const first = expandTemplate(alternative[0], lookup, atMs, escape);
        out += first !== '' ? first : expandTemplate(alternative[1], lookup, atMs, escape);
      } else if (body.startsWith('%{')) out += expandTemplate(body, lookup, atMs, escape);
      else {
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
