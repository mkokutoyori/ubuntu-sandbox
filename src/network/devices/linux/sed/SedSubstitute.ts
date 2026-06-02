/**
 * The `s///` substitution engine: replacement-template expansion (with
 * `&`, `\1`-`\9`, `\n`/`\t`, and the GNU case operators `\U \L \u \l \E`)
 * and occurrence control (the `g` flag and an Nth-occurrence count).
 */

interface ReplaceState {
  sticky: '' | 'U' | 'L';
  once: '' | 'u' | 'l';
}

function emit(out: string, text: string, st: ReplaceState): string {
  let acc = out;
  for (const ch of text) {
    let c = ch;
    if (st.once === 'u') { c = c.toUpperCase(); st.once = ''; }
    else if (st.once === 'l') { c = c.toLowerCase(); st.once = ''; }
    else if (st.sticky === 'U') c = c.toUpperCase();
    else if (st.sticky === 'L') c = c.toLowerCase();
    acc += c;
  }
  return acc;
}

export function expandReplacement(template: string, match: string, groups: (string | undefined)[]): string {
  let out = '';
  const st: ReplaceState = { sticky: '', once: '' };
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c === '\\') {
      const n = template[i + 1];
      i++;
      if (n >= '0' && n <= '9') {
        const idx = Number(n);
        out = emit(out, idx === 0 ? match : (groups[idx - 1] ?? ''), st);
      } else if (n === 'n') out = emit(out, '\n', st);
      else if (n === 't') out = emit(out, '\t', st);
      else if (n === 'r') out = emit(out, '\r', st);
      else if (n === '&') out = emit(out, '&', st);
      else if (n === '\\') out = emit(out, '\\', st);
      else if (n === 'U') st.sticky = 'U';
      else if (n === 'L') st.sticky = 'L';
      else if (n === 'E') st.sticky = '';
      else if (n === 'u') st.once = 'u';
      else if (n === 'l') st.once = 'l';
      else out = emit(out, n ?? '', st);
      continue;
    }
    if (c === '&') { out = emit(out, match, st); continue; }
    out = emit(out, c, st);
  }
  return out;
}

export interface SubstituteResult {
  result: string;
  changed: boolean;
}

/**
 * Apply `s/re/template/` to `text`. `global` replaces every match from the
 * `nth` onward; otherwise only the `nth` match is replaced (`nth` defaults
 * to 1, giving classic "first match" / "all matches" behaviour).
 */
export function substitute(text: string, re: RegExp, template: string, global: boolean, nth: number): SubstituteResult {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const g = new RegExp(re.source, flags);
  let out = '';
  let last = 0;
  let count = 0;
  let changed = false;
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    count++;
    const replaceThis = global ? count >= nth : count === nth;
    if (replaceThis) {
      out += text.slice(last, m.index) + expandReplacement(template, m[0], m.slice(1));
      last = m.index + m[0].length;
      changed = true;
      if (!global) break;
    }
    if (m[0] === '') g.lastIndex++;
  }
  out += text.slice(last);
  return { result: out, changed };
}
