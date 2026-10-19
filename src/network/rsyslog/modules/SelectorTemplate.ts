import { RS_RET } from '../engine/Log';
import type { RuntimeLog } from '../engine/Modules';

export function parseSelectorTemplate(remaining: string, fallback: string, runtime: RuntimeLog): string | null {
  let text = remaining.trimStart();
  if (text.startsWith(';')) text = text.slice(1);
  else if (text !== '' && !text.startsWith('#')) {
    runtime.error("invalid character in selector line - ';template' expected", RS_RET.ERR);
    return null;
  }
  text = text.trimStart();
  if (text === '' || text.startsWith('#')) return fallback;
  return /^[^#\s]*/.exec(text)?.[0] ?? fallback;
}
