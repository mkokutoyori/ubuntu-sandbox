import { wordClasses } from './VimCharClass';
import { OPTION_DEFAULTS } from './VimOptionDefaults';

export type VimOptionProfile = 'vim' | 'vi';

export type OptionValue = boolean | number | string;

type OptionKind = 'bool' | 'number' | 'string';

type OptionScope = 'local' | 'global';

interface NumberRule {
  readonly min: number;
  readonly max: number;
  readonly belowMin: 'E487' | 'E474';
  readonly clamp: boolean;
}

interface ProfileDefaults {
  readonly vim: OptionValue;
  readonly vi: OptionValue;
}

interface OptionDef {
  readonly name: string;
  readonly short: string;
  readonly kind: OptionKind;
  readonly scope: OptionScope;
  readonly reset: ProfileDefaults;
  readonly startup?: ProfileDefaults;
  readonly number?: NumberRule;
  readonly commaList?: boolean;
  readonly flagList?: string;
  readonly normalize?: (value: string) => string | null;
}

const LISTCHARS_ITEM = /^(eol|tab|space|multispace|lead|leadmultispace|trail|extends|precedes|conceal|nbsp):(.*)$/;

function listcharsValid(value: string): boolean {
  if (value === '') return true;
  for (const item of value.split(',')) {
    const match = LISTCHARS_ITEM.exec(item);
    if (!match) return false;
    const cells = [...match[2]].length;
    if (match[1] === 'tab') {
      if (cells !== 2 && cells !== 3) return false;
    } else if (match[1] === 'multispace' || match[1] === 'leadmultispace') {
      if (cells < 1) return false;
    } else if (cells !== 1) {
      return false;
    }
  }
  return true;
}

function colorcolumnValid(value: string): boolean {
  if (value === '') return true;
  return value.split(',').every((item) => /^[+-]?\d+$/.test(item));
}

const DISPLAY_WORDS: ReadonlySet<string> = new Set(['lastline', 'truncate', 'uhex', 'msgsep']);

function displayValid(value: string): boolean {
  if (value === '') return true;
  return value.split(',').every((item) => DISPLAY_WORDS.has(item));
}

function matchpairsValid(value: string): boolean {
  return value === '' || value.split(',').every((item) => [...item].length === 3 && [...item][1] === ':');
}

function same<T extends OptionValue>(value: T): ProfileDefaults {
  return { vim: value, vi: value };
}

const DEFS: readonly OptionDef[] = [
  { name: 'number', short: 'nu', kind: 'bool', scope: 'local', reset: same(false) },
  { name: 'relativenumber', short: 'rnu', kind: 'bool', scope: 'local', reset: same(false) },
  { name: 'numberwidth', short: 'nuw', kind: 'number', scope: 'local', reset: { vim: 4, vi: 8 }, number: { min: 1, max: 20, belowMin: 'E487', clamp: true } },
  { name: 'list', short: 'list', kind: 'bool', scope: 'local', reset: same(false) },
  { name: 'listchars', short: 'lcs', kind: 'string', scope: 'local', reset: same('eol:$'), commaList: true, normalize: (v) => (listcharsValid(v) ? v : null) },
  { name: 'showmatch', short: 'sm', kind: 'bool', scope: 'global', reset: same(false) },
  { name: 'matchtime', short: 'mat', kind: 'number', scope: 'global', reset: same(5), number: { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, belowMin: 'E487', clamp: false } },
  { name: 'matchpairs', short: 'mps', kind: 'string', scope: 'local', reset: same('(:),{:},[:]'), commaList: true, normalize: (v) => (matchpairsValid(v) ? v : null) },
  { name: 'incsearch', short: 'is', kind: 'bool', scope: 'global', reset: same(false), startup: { vim: true, vi: false } },
  { name: 'hlsearch', short: 'hls', kind: 'bool', scope: 'global', reset: same(false) },
  { name: 'ignorecase', short: 'ic', kind: 'bool', scope: 'global', reset: same(false) },
  { name: 'gdefault', short: 'gd', kind: 'bool', scope: 'global', reset: same(false) },
  { name: 'smartcase', short: 'scs', kind: 'bool', scope: 'global', reset: same(false) },
  { name: 'iskeyword', short: 'isk', kind: 'string', scope: 'local', reset: { vim: '@,48-57,_,192-255', vi: '@,48-57,_' }, commaList: true, normalize: (v) => (wordClasses(v) === null ? null : v) },
  { name: 'report', short: 'report', kind: 'number', scope: 'global', reset: same(2), number: { min: 0, max: Number.MAX_SAFE_INTEGER, belowMin: 'E487', clamp: false } },
  { name: 'autoindent', short: 'ai', kind: 'bool', scope: 'local', reset: same(false) },
  { name: 'colorcolumn', short: 'cc', kind: 'string', scope: 'local', reset: same(''), commaList: true, normalize: (v) => (colorcolumnValid(v) ? v : null) },
  { name: 'tabstop', short: 'ts', kind: 'number', scope: 'local', reset: same(8), number: { min: 1, max: 9999, belowMin: 'E487', clamp: false } },
  { name: 'shiftwidth', short: 'sw', kind: 'number', scope: 'local', reset: same(8), number: { min: 0, max: Number.MAX_SAFE_INTEGER, belowMin: 'E487', clamp: false } },
  { name: 'softtabstop', short: 'sts', kind: 'number', scope: 'local', reset: same(0), number: { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, belowMin: 'E487', clamp: false } },
  { name: 'expandtab', short: 'et', kind: 'bool', scope: 'local', reset: same(false) },
  { name: 'wrap', short: 'wrap', kind: 'bool', scope: 'local', reset: same(true) },
  { name: 'scrolloff', short: 'so', kind: 'number', scope: 'local', reset: same(0), startup: { vim: 5, vi: 0 }, number: { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, belowMin: 'E487', clamp: false } },
  { name: 'sidescroll', short: 'ss', kind: 'number', scope: 'global', reset: same(0), number: { min: 0, max: Number.MAX_SAFE_INTEGER, belowMin: 'E487', clamp: false } },
  { name: 'sidescrolloff', short: 'siso', kind: 'number', scope: 'local', reset: same(0), number: { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, belowMin: 'E487', clamp: false } },
  { name: 'wrapscan', short: 'ws', kind: 'bool', scope: 'global', reset: same(true) },
  { name: 'display', short: 'dy', kind: 'string', scope: 'global', reset: same(''), startup: { vim: 'truncate', vi: '' }, commaList: true, normalize: (v) => (displayValid(v) ? v : null) },
  { name: 'ruler', short: 'ru', kind: 'bool', scope: 'global', reset: same(false), startup: { vim: true, vi: false } },
  { name: 'showcmd', short: 'sc', kind: 'bool', scope: 'global', reset: same(false), startup: { vim: true, vi: false } },
  { name: 'showmode', short: 'smd', kind: 'bool', scope: 'global', reset: { vim: true, vi: false } },
  { name: 'scroll', short: 'scr', kind: 'number', scope: 'local', reset: same(0), number: { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, belowMin: 'E487', clamp: false } },
  { name: 'filetype', short: 'ft', kind: 'string', scope: 'local', reset: same(''), normalize: (v) => (/^[A-Za-z0-9._-]*$/.test(v) ? v : null) },
  { name: 'fileformat', short: 'ff', kind: 'string', scope: 'local', reset: same('unix'), normalize: (v) => (v === '' || v === 'unix' || v === 'dos' || v === 'mac' ? v : null) },
  { name: 'fileencoding', short: 'fenc', kind: 'string', scope: 'local', reset: same('') },
  { name: 'mouse', short: 'mouse', kind: 'string', scope: 'global', reset: same(''), flagList: 'nvichar' },
];

const BY_NAME: ReadonlyMap<string, OptionDef> = new Map(
  DEFS.flatMap((def) => [[def.name, def] as const, [def.short, def] as const]),
);

const UNMODELLED_DEFAULTS: ReadonlyMap<string, OptionValue> = new Map(
  OPTION_DEFAULTS.flatMap(([name, short, value]) => [[name, value] as const, [short, value] as const]),
);

export type OptionName =
  | 'number' | 'relativenumber' | 'numberwidth' | 'list' | 'listchars' | 'showmatch' | 'matchtime' | 'matchpairs' | 'incsearch'
  | 'hlsearch' | 'ignorecase' | 'smartcase' | 'iskeyword' | 'gdefault' | 'report' | 'autoindent' | 'colorcolumn' | 'tabstop' | 'shiftwidth' | 'softtabstop'
  | 'expandtab' | 'wrap' | 'scrolloff' | 'sidescroll' | 'sidescrolloff' | 'wrapscan' | 'display'
  | 'ruler' | 'showcmd' | 'showmode' | 'scroll' | 'filetype' | 'fileformat' | 'fileencoding' | 'mouse';

export type SetScope = 'set' | 'setlocal' | 'setglobal';

export interface SetOutcome {
  readonly message: string;
  readonly error: boolean;
}

type Operation = 'none' | '?' | '!' | '&' | '=' | '+=' | '-=' | '^=';

interface Step {
  readonly next: number;
  readonly error: string | null;
}

interface Refusal {
  readonly code: string;
  readonly what: string;
}

function isBlank(ch: string): boolean {
  return ch === ' ' || ch === '\t';
}

function valueEnd(source: string, from: number): number {
  let at = from;
  while (at < source.length && !isBlank(source[at])) at += source[at] === '\\' && at + 1 < source.length ? 2 : 1;
  return at;
}

function unescape(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

type ParsedNumber = { readonly ok: true; readonly value: number } | { readonly ok: false };

function parseNumber(text: string): ParsedNumber {
  const match = /^(-?)(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|0[0-7]*|[1-9][0-9]*)$/.exec(text);
  if (!match) return { ok: false };
  const body = match[2];
  let magnitude: number;
  if (/^0[xX]/.test(body)) magnitude = parseInt(body.slice(2), 16);
  else if (/^0[bB]/.test(body)) magnitude = parseInt(body.slice(2), 2);
  else if (/^0[oO]/.test(body)) magnitude = parseInt(body.slice(2), 8);
  else if (body.length > 1 && body[0] === '0') magnitude = parseInt(body, 8);
  else magnitude = parseInt(body, 10);
  return { ok: true, value: match[1] === '-' ? -magnitude : magnitude };
}

export class VimOptions {
  private readonly local = new Map<string, OptionValue>();
  private readonly global = new Map<string, OptionValue>();
  private readonly listeners = new Set<(name: OptionName) => void>();

  constructor(private readonly profile: VimOptionProfile) {
    for (const def of DEFS) {
      const value = (def.startup ?? def.reset)[profile];
      this.local.set(def.name, value);
      this.global.set(def.name, value);
    }
  }

  onChange(listener: (name: OptionName) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  lookup(name: string, scope: 'effective' | 'local' | 'global' = 'effective'): OptionValue | undefined {
    const def = BY_NAME.get(name);
    if (def !== undefined) return (scope === 'global' ? this.global : this.local).get(def.name);
    return this.profile === 'vim' ? UNMODELLED_DEFAULTS.get(name) : undefined;
  }

  bool(name: OptionName): boolean { return this.local.get(name) as boolean; }
  number(name: OptionName): number { return this.local.get(name) as number; }
  string(name: OptionName): string { return this.local.get(name) as string; }

  get tabstop(): number { return this.number('tabstop'); }
  get shiftwidth(): number { return this.number('shiftwidth') === 0 ? this.tabstop : this.number('shiftwidth'); }
  get softtabstop(): number {
    const value = this.number('softtabstop');
    if (value === 0) return 0;
    return value < 0 ? this.shiftwidth : value;
  }
  get expandtab(): boolean { return this.bool('expandtab'); }
  get wrap(): boolean { return this.bool('wrap'); }
  get scrolloff(): number { return Math.max(0, this.number('scrolloff')); }
  get sidescroll(): number { return this.number('sidescroll'); }
  get sidescrolloff(): number { return Math.max(0, this.number('sidescrolloff')); }

  assign(name: OptionName, value: OptionValue): void {
    this.local.set(name, value);
    this.global.set(name, value);
    this.notify(name);
  }

  apply(argument: string, scope: SetScope = 'set'): SetOutcome {
    const lines: string[] = [];
    let at = 0;
    for (;;) {
      while (at < argument.length && isBlank(argument[at])) at++;
      if (at >= argument.length) break;
      const step = this.applyOne(argument, at, scope, lines);
      if (step.error !== null) return { message: step.error, error: true };
      at = step.next;
    }
    return { message: lines.join('\n'), error: false };
  }

  private notify(name: string): void {
    for (const listener of [...this.listeners]) listener(name as OptionName);
  }

  private readFrom(scope: SetScope): Map<string, OptionValue> {
    return scope === 'setglobal' ? this.global : this.local;
  }

  private write(def: OptionDef, scope: SetScope, value: OptionValue): void {
    const global = def.scope === 'global';
    if (scope !== 'setglobal' || global) this.local.set(def.name, value);
    if (scope !== 'setlocal' || global) this.global.set(def.name, value);
    this.notify(def.name);
  }

  private show(def: OptionDef, scope: SetScope): string {
    const value = this.readFrom(scope).get(def.name)!;
    if (def.kind === 'bool') return value ? `  ${def.name}` : `no${def.name}`;
    return `  ${def.name}=${value}`;
  }

  private applyOne(source: string, start: number, scope: SetScope, lines: string[]): Step {
    let at = start;
    const failure = (code: string, what: string, from: number): Step => {
      const end = valueEnd(source, from);
      return { next: source.length, error: `${code}: ${what}: ${source.slice(start, end < source.length ? end + 1 : end)}` };
    };

    if (source.startsWith('all&', at)) {
      for (const def of DEFS) {
        if (def.name !== 'scroll') this.write(def, scope === 'setglobal' ? 'set' : scope, def.reset[this.profile]);
      }
      return { next: at + 4, error: null };
    }

    let prefix: 'none' | 'no' | 'inv' = 'none';
    if (source.startsWith('no', at)) { prefix = 'no'; at += 2; }
    else if (source.startsWith('inv', at)) { prefix = 'inv'; at += 3; }

    const nameMatch = /^[A-Za-z0-9_]+/.exec(source.slice(at));
    const def = nameMatch ? BY_NAME.get(nameMatch[0]) : undefined;
    if (!def) return failure('E518', 'Unknown option', at);
    at += nameMatch![0].length;

    let probe = at;
    while (probe < source.length && isBlank(source[probe])) probe++;
    const marker = source[probe];
    let operation: Operation = 'none';
    let operandAt = at;
    if (marker === '?' || marker === '!' || marker === '&') { operation = marker; operandAt = probe + 1; }
    else if (marker === '=' || marker === ':') { operation = '='; operandAt = probe + 1; }
    else if ((marker === '+' || marker === '-' || marker === '^') && source[probe + 1] === '=') {
      operation = `${marker}=` as Operation;
      operandAt = probe + 2;
    } else if (at < source.length && !isBlank(source[at])) {
      return failure('E518', 'Unknown option', at);
    }

    if (def.kind === 'bool') {
      if (operation === '=' || operation === '+=' || operation === '-=' || operation === '^=') {
        return failure('E474', 'Invalid argument', operandAt);
      }
      return this.applyBool(def, prefix, operation, scope, lines, operandAt);
    }
    if (prefix !== 'none') return failure('E474', 'Invalid argument', operandAt);
    if (operation === '!') return failure('E488', 'Trailing characters', operandAt);
    if (operation === 'none' || operation === '?') {
      lines.push(this.show(def, scope));
      return { next: operandAt, error: null };
    }
    if (operation === '&') {
      this.write(def, scope, def.reset[this.profile]);
      return { next: operandAt, error: null };
    }

    const end = valueEnd(source, operandAt);
    const valueText = unescape(source.slice(operandAt, end));
    const refusal = def.kind === 'number'
      ? this.assignNumber(def, operation, valueText, scope)
      : this.assignString(def, operation, valueText, scope);
    if (refusal !== null) return failure(refusal.code, refusal.what, operandAt);
    return { next: end, error: null };
  }

  private applyBool(
    def: OptionDef, prefix: 'none' | 'no' | 'inv', operation: Operation, scope: SetScope, lines: string[], next: number,
  ): Step {
    const current = this.readFrom(scope).get(def.name) as boolean;
    if (operation === '?') lines.push(this.show(def, scope));
    else if (operation === '&') this.write(def, scope, def.reset[this.profile] as boolean);
    else if (operation === '!') this.write(def, scope, !current);
    else if (prefix === 'none') this.write(def, scope, true);
    else if (prefix === 'no') this.write(def, scope, false);
    else this.write(def, scope, !current);
    return { next, error: null };
  }

  private assignNumber(def: OptionDef, operation: Operation, valueText: string, scope: SetScope): Refusal | null {
    const parsed = parseNumber(valueText);
    if (!parsed.ok) return { code: 'E521', what: 'Number required after =' };
    const current = this.readFrom(scope).get(def.name) as number;
    let next = parsed.value;
    if (operation === '+=') next = current + parsed.value;
    else if (operation === '-=') next = current - parsed.value;
    else if (operation === '^=') next = current * parsed.value;
    const rule = def.number!;
    if (next < rule.min) {
      if (rule.clamp) this.write(def, scope, rule.min);
      return { code: rule.belowMin, what: rule.belowMin === 'E487' ? 'Argument must be positive' : 'Invalid argument' };
    }
    if (next > rule.max) {
      if (rule.clamp) this.write(def, scope, rule.max);
      return { code: 'E474', what: 'Invalid argument' };
    }
    this.write(def, scope, next);
    return null;
  }

  private assignFlags(def: OptionDef, operation: Operation, valueText: string, scope: SetScope): Refusal | null {
    const current = this.readFrom(scope).get(def.name) as string;
    for (const flag of valueText) {
      if (!def.flagList!.includes(flag)) return { code: 'E539', what: `Illegal character <${flag}>` };
    }
    const unique = (text: string): string => [...new Set(text)].join('');
    let next: string;
    if (operation === '=') next = unique(valueText);
    else if (operation === '+=') next = unique(current + valueText);
    else if (operation === '^=') next = unique(valueText + current);
    else next = [...current].filter((flag) => !valueText.includes(flag)).join('');
    this.write(def, scope, next);
    return null;
  }

  private assignString(def: OptionDef, operation: Operation, valueText: string, scope: SetScope): Refusal | null {
    if (def.flagList !== undefined) return this.assignFlags(def, operation, valueText, scope);
    const current = this.readFrom(scope).get(def.name) as string;
    let next = valueText;
    if (operation !== '=') {
      const separator = def.commaList ? ',' : '';
      const present = def.commaList === true && operation !== '-=' && current.split(',').includes(valueText);
      if (present) next = current;
      else if (operation === '+=') next = current === '' || valueText === '' ? current + valueText : current + separator + valueText;
      else if (operation === '^=') next = current === '' || valueText === '' ? valueText + current : valueText + separator + current;
      else if (def.commaList) next = current.split(',').filter((item, index, all) => !(item === valueText && all.indexOf(item) === index)).join(',');
      else next = current.includes(valueText) ? current.replace(valueText, '') : current;
    }
    if (def.normalize && def.normalize(next) === null) return { code: 'E474', what: 'Invalid argument' };
    this.write(def, scope, next);
    return null;
  }
}
