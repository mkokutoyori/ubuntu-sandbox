const S_ISUID = 0o4000;
const S_ISGID = 0o2000;
const S_ISVTX = 0o1000;
const S_IRWXU = 0o700;
const S_IRWXG = 0o070;
const S_IRWXO = 0o007;
const ALL_BITS = 0o7777;
const READ_ALL = 0o444;
const WRITE_ALL = 0o222;
const EXEC_ALL = 0o111;

type Operation = '+' | '-' | '=';
type Flag = 'ordinary' | 'execute-if-any' | 'copy';

interface Change {
  readonly operation: Operation;
  readonly flag: Flag;
  readonly affected: number;
  readonly value: number;
}

export type ModeSpec =
  | { readonly kind: 'numeric'; readonly value: number; readonly digits: number }
  | { readonly kind: 'symbolic'; readonly changes: readonly Change[] };

const COPY_SOURCE: Readonly<Record<string, number>> = { u: S_IRWXU, g: S_IRWXG, o: S_IRWXO };

export function compileMode(text: string): ModeSpec | null {
  if (/^[0-7]+$/.test(text)) {
    const value = parseInt(text, 8);
    return value > ALL_BITS ? null : { kind: 'numeric', value, digits: text.length };
  }
  if (/^\d+$/.test(text)) return null;
  const changes: Change[] = [];
  let at = 0;
  const clauses = text.split(',');
  for (const clause of clauses) {
    at = 0;
    let affected = 0;
    while (at < clause.length && 'ugoa'.includes(clause[at])) {
      switch (clause[at]) {
        case 'u': affected |= S_ISUID | S_IRWXU; break;
        case 'g': affected |= S_ISGID | S_IRWXG; break;
        case 'o': affected |= S_ISVTX | S_IRWXO; break;
        default: affected |= ALL_BITS; break;
      }
      at++;
    }
    if (at >= clause.length || !'+-='.includes(clause[at])) return null;
    while (at < clause.length && '+-='.includes(clause[at])) {
      const operation = clause[at] as Operation;
      at++;
      let value = 0;
      let flag: Flag = 'ordinary';
      if (at < clause.length && 'ugo'.includes(clause[at])) {
        flag = 'copy';
        value = COPY_SOURCE[clause[at]];
        at++;
      } else {
        while (at < clause.length && 'rwxXst'.includes(clause[at])) {
          switch (clause[at]) {
            case 'r': value |= READ_ALL; break;
            case 'w': value |= WRITE_ALL; break;
            case 'x': value |= EXEC_ALL; break;
            case 'X': flag = 'execute-if-any'; break;
            case 's': value |= S_ISUID | S_ISGID; break;
            default: value |= S_ISVTX; break;
          }
          at++;
        }
      }
      changes.push({ operation, flag, affected, value });
    }
    if (at < clause.length) return null;
  }
  return { kind: 'symbolic', changes };
}

export function applyMode(spec: ModeSpec, oldMode: number, isDirectory: boolean, umask: number): number {
  if (spec.kind === 'numeric') {
    const keep = isDirectory && spec.digits < 5 ? oldMode & (S_ISUID | S_ISGID) & ~spec.value : 0;
    return spec.value | keep;
  }
  let mode = oldMode & ALL_BITS;
  for (const change of spec.changes) {
    let value = change.value;
    if (change.flag === 'execute-if-any') {
      if (isDirectory || (mode & EXEC_ALL) !== 0) value |= EXEC_ALL;
    } else if (change.flag === 'copy') {
      const copied = mode & value;
      value = (copied & READ_ALL ? READ_ALL : 0) | (copied & WRITE_ALL ? WRITE_ALL : 0) | (copied & EXEC_ALL ? EXEC_ALL : 0);
    }
    const affected = change.affected === 0 ? ALL_BITS & ~umask : change.affected;
    if (change.operation === '+') mode |= value & affected;
    else if (change.operation === '-') mode &= ~(value & affected);
    else {
      const preserved = isDirectory ? mode & (S_ISUID | S_ISGID) & ~(value & (S_ISUID | S_ISGID)) : 0;
      mode = (mode & ~affected) | (value & affected) | (change.affected === 0 ? preserved : 0);
    }
  }
  return mode;
}

export function parseChmodMode(modeStr: string, current: number): number | null {
  const spec = compileMode(modeStr);
  return spec === null ? null : applyMode(spec, current, false, 0);
}
