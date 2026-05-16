/**
 * CollectionCmdlets — Pipeline collection operators.
 *
 * Where-Object, ForEach-Object, Select-Object, Sort-Object,
 * Measure-Object, Group-Object, Get-Unique, Tee-Object, Compare-Object,
 * Select-String, Format-Table, Format-List, Get-Member.
 *
 * None require system providers.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { PSScriptBlock } from '@/powershell/parser/PSASTNode';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

// ─── Helpers ───────────────────────────────────────────────────────────────

function toArray(val: PSValue): PSValue[] {
  if (val === null || val === undefined) return [];
  return Array.isArray(val) ? val : [val];
}

/**
 * Flatten a list of positional arguments into a flat list of property
 * specifications. `Select-Object Name, Status` reaches the cmdlet with
 * positional[0] = ['Name','Status'] (one array arg) — without flattening
 * the cmdlet would treat the whole array as a single non-string property
 * and silently produce empty result objects.
 */
function flattenProps(items: PSValue[]): PSValue[] {
  const out: PSValue[] = [];
  for (const it of items) {
    if (Array.isArray(it)) out.push(...flattenProps(it as PSValue[]));
    else if (it !== null && it !== undefined) out.push(it);
  }
  return out;
}

/** A resolved display column: a header name + a per-item value getter. */
type ColSpec = { name: string; get: (item: PSValue) => PSValue };

function pickProp(item: PSValue, name: string): PSValue {
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    const rec = item as Record<string, PSValue>;
    const k = Object.keys(rec).find(x => x.toLowerCase() === name.toLowerCase());
    return k !== undefined ? (rec[k] ?? '') : '';
  }
  return name.toLowerCase() === 'value' ? item : '';
}

/**
 * Resolve Format-* / Select-style column args into ordered ColSpecs.
 * Handles plain names, `*` (expand to the sample's keys) and calculated
 * properties `@{ Name/N/Label/L = …; Expression/E = {scriptblock|name} }`.
 */
function resolveColumns(raw: PSValue[], sample: PSValue, ctx: CmdletContext): ColSpec[] {
  const sampleKeys = sample !== null && typeof sample === 'object' && !Array.isArray(sample)
    ? Object.keys(sample as Record<string, PSValue>)
    : [];
  const cols: ColSpec[] = [];
  for (const p of raw) {
    if (typeof p === 'string' || typeof p === 'number') {
      const s = String(p);
      if (s === '*') {
        for (const k of sampleKeys) cols.push({ name: k, get: it => pickProp(it, k) });
      } else {
        cols.push({ name: s, get: it => pickProp(it, s) });
      }
    } else if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
      const h = p as Record<string, PSValue>;
      const name = psValueToString(
        h['Name'] ?? h['name'] ?? h['N'] ?? h['n'] ??
        h['Label'] ?? h['label'] ?? h['L'] ?? h['l'] ?? '');
      const expr = h['Expression'] ?? h['expression'] ?? h['E'] ?? h['e'];
      if (!name) continue;
      if (isScriptBlockVal(expr)) {
        cols.push({ name, get: it => ctx.invokeBlock(expr as PSScriptBlock, it) });
      } else {
        const pn = psValueToString(expr);
        cols.push({ name, get: it => pickProp(it, pn) });
      }
    }
  }
  return cols;
}

function stringArgs(pos: PSValue[], named: Record<string, PSValue>, key: string): string[] {
  const src = named[key] ?? (pos.length > 0 ? pos : null);
  if (!src) return [];
  const flat: PSValue[] = [];
  const walk = (v: PSValue) => {
    if (Array.isArray(v)) for (const e of v) walk(e);
    else if (v !== null && v !== undefined) flat.push(v);
  };
  walk(src as PSValue);
  return flat.map(v => psValueToString(v));
}

// ─── Where-Object ──────────────────────────────────────────────────────────

export class WhereObjectCmdlet implements ICmdlet {
  readonly name = 'where-object';
  readonly parameters = ['FilterScript', 'InputObject', 'Property', 'Value', 'EQ', 'NE', 'GT', 'GE', 'LT', 'LE', 'Like', 'NotLike', 'Match', 'NotMatch', 'Contains', 'NotContains', 'In', 'NotIn', 'Is', 'IsNot', 'Not'] as const;
  readonly aliases = ['where', '?'] as const;

  execute(ctx: CmdletContext): PSValue {
    const input = toArray(ctx.pipeInput);

    // Form 1 — scriptblock: `Where-Object { $_.X -gt 3 }` /
    // `Where-Object -FilterScript { ... }`.
    const sb = (ctx.named['filterscript'] ?? ctx.positional[0]) as PSValue;
    if (isScriptBlockVal(sb)) {
      return input.filter(item => isTruthy(ctx.invokeBlock(sb as PSScriptBlock, item)));
    }

    // Form 2 — comparison parameters:
    //   `Where-Object Status -EQ Running`
    //   `Where-Object -Property WS -GT 0`
    //   `Where-Object Name -Like "*o*"`   /   `Where-Object Enabled` (-Not)
    // `-EQ`/`-GT`/… are in PS_OPERATOR_PARAMS so the parser treats them
    // as VALUELESS operator params and pushes the comparison value into
    // the positional list. Layout:
    //   `Where-Object Status -EQ Running`   → pos = [Status, Running]
    //   `Where-Object -Property WS -GT 0`   → named.property=WS, pos=[0]
    const propNamed = ctx.named['property'] !== undefined;
    const prop = psValueToString(
      propNamed ? ctx.named['property'] : (ctx.positional[0] ?? ''));
    if (!prop) return input;

    const OPS = ['eq','ne','gt','ge','lt','le','like','notlike','match',
      'notmatch','contains','notcontains','in','notin','is','isnot'] as const;
    let op: string | null = null;
    let rhs: PSValue = undefined;
    for (const o of OPS) {
      if (ctx.named[o] === undefined) continue;
      op = o;
      const v = ctx.named[o];
      // If the parser actually attached a value, use it; otherwise the
      // value is the first positional that isn't the property name.
      rhs = (v === true || v === null || v === undefined)
        ? (propNamed ? ctx.positional[0] : ctx.positional[1])
        : v;
      break;
    }
    // `-Not` switch, or a bare property name → truthiness test.
    const notSwitch = ctx.named['not'] === true;

    const lp = prop.toLowerCase();
    const pick = (item: PSValue): PSValue => {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const rec = item as Record<string, PSValue>;
        const k = Object.keys(rec).find(x => x.toLowerCase() === lp);
        return k !== undefined ? rec[k] : undefined;
      }
      // Intrinsic members on primitives/arrays (`Where-Object Length -GE 2`).
      if (typeof item === 'string') {
        if (lp === 'length') return item.length;
      }
      if (Array.isArray(item)) {
        if (lp === 'length' || lp === 'count') return (item as PSValue[]).length;
      }
      return undefined;
    };

    if (!op) {
      return input.filter(item => {
        const v = pick(item);
        return notSwitch ? !isTruthy(v) : isTruthy(v);
      });
    }

    return input.filter(item => compare(pick(item), op!, rhs));
  }
}

/** Loose, PowerShell-style comparison for the Where-Object/-operator form. */
function compare(actual: PSValue, op: string, expected: PSValue): boolean {
  const aNum = Number(actual);
  const eNum = Number(expected);
  const bothNum = !Number.isNaN(aNum) && !Number.isNaN(eNum)
    && actual !== null && actual !== '' && expected !== null && expected !== '';
  const aStr = actual === null || actual === undefined ? '' : String(actual);
  const eStr = expected === null || expected === undefined ? '' : String(expected);
  const ci = (s: string) => s.toLowerCase();
  const wild = (pat: string) =>
    new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');

  switch (op) {
    case 'eq':   return bothNum ? aNum === eNum : ci(aStr) === ci(eStr);
    case 'ne':   return bothNum ? aNum !== eNum : ci(aStr) !== ci(eStr);
    case 'gt':   return bothNum ? aNum >  eNum : aStr >  eStr;
    case 'ge':   return bothNum ? aNum >= eNum : aStr >= eStr;
    case 'lt':   return bothNum ? aNum <  eNum : aStr <  eStr;
    case 'le':   return bothNum ? aNum <= eNum : aStr <= eStr;
    case 'like':     return wild(eStr).test(aStr);
    case 'notlike':  return !wild(eStr).test(aStr);
    case 'match':    return new RegExp(eStr, 'i').test(aStr);
    case 'notmatch': return !new RegExp(eStr, 'i').test(aStr);
    case 'contains':    return Array.isArray(actual)
      ? (actual as PSValue[]).some(x => ci(String(x)) === ci(eStr)) : ci(aStr) === ci(eStr);
    case 'notcontains': return !(Array.isArray(actual)
      ? (actual as PSValue[]).some(x => ci(String(x)) === ci(eStr)) : ci(aStr) === ci(eStr));
    case 'in':   return Array.isArray(expected)
      ? (expected as PSValue[]).some(x => ci(String(x)) === ci(aStr)) : ci(aStr) === ci(eStr);
    case 'notin':return !(Array.isArray(expected)
      ? (expected as PSValue[]).some(x => ci(String(x)) === ci(aStr)) : ci(aStr) === ci(eStr));
    case 'is':   return typeof actual === eStr.toLowerCase()
      || (eStr.toLowerCase().includes('int') && bothNum);
    case 'isnot':return !(typeof actual === eStr.toLowerCase());
    default:     return false;
  }
}

function isScriptBlockVal(v: PSValue): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && (v as Record<string, unknown>).type === 'ScriptBlock';
}

function isTruthy(val: PSValue): boolean {
  if (val === null || val === undefined) return false;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number')  return val !== 0;
  if (typeof val === 'string')  return val.length > 0;
  if (Array.isArray(val))       return val.length > 0;
  return true;
}

// ─── ForEach-Object ────────────────────────────────────────────────────────

export class ForEachObjectCmdlet implements ICmdlet {
  readonly name = 'foreach-object';
  readonly parameters = ['Process', 'InputObject', 'Begin', 'End', 'MemberName', 'ArgumentList'] as const;
  readonly aliases = ['foreach', '%'] as const;

  execute(ctx: CmdletContext): PSValue {
    const input  = toArray(ctx.pipeInput);
    const script = (ctx.named['process'] ?? ctx.positional[0]) as PSScriptBlock;
    const begin  = ctx.named['begin']  as PSScriptBlock | undefined;
    const end    = ctx.named['end']    as PSScriptBlock | undefined;

    const out: PSValue[] = [];
    const collect = (val: PSValue) => {
      if (val === null || val === undefined) return;
      if (Array.isArray(val)) out.push(...val);
      else out.push(val);
    };

    // -Begin/-Process/-End (and every -Process iteration) share ONE scope so
    // accumulators like `-Begin { $s=0 } -Process { $s+=$_ } -End { $s }`
    // work, as they do in real PowerShell.
    const scope = ctx.runtime.makeChildScope(ctx.env);
    if (begin)  collect(ctx.runtime.invokeBlockInScope(begin,  scope, null));
    if (script) {
      for (const item of input) collect(ctx.runtime.invokeBlockInScope(script, scope, item));
    }
    if (end)    collect(ctx.runtime.invokeBlockInScope(end,    scope, null));

    if (out.length === 0) return null;
    return out.length === 1 ? out[0] : out;
  }
}

// ─── Select-Object ────────────────────────────────────────────────────────

export class SelectObjectCmdlet implements ICmdlet {
  readonly name = 'select-object';
  readonly parameters = ['Property', 'ExcludeProperty', 'ExpandProperty', 'InputObject', 'First', 'Last', 'Skip', 'SkipLast', 'Index', 'Unique', 'Wait'] as const;
  readonly aliases = ['select'] as const;

  execute(ctx: CmdletContext): PSValue {
    const input      = toArray(ctx.pipeInput);
    const rawProps   = flattenProps(ctx.named['property'] !== undefined
      ? toArray(ctx.named['property'])
      : ctx.positional);
    const first      = ctx.named['first']  !== undefined ? Number(ctx.named['first'])  : undefined;
    const last       = ctx.named['last']   !== undefined ? Number(ctx.named['last'])   : undefined;
    const skip       = ctx.named['skip']   !== undefined ? Number(ctx.named['skip'])   : 0;
    const skipLast   = ctx.named['skiplast'] !== undefined ? Number(ctx.named['skiplast']) : 0;
    const unique     = ctx.named['unique'] === true;
    const indexRaw   = ctx.named['index'];
    const expandProp = ctx.named['expandproperty'] !== undefined
      ? psValueToString(ctx.named['expandproperty']) : null;

    let items: PSValue[];
    if (indexRaw !== undefined && indexRaw !== null) {
      // -Index selects ONLY the elements at the given positions, in the
      // order requested, ignoring out-of-range indices (and -First/-Last).
      const idxs = (Array.isArray(indexRaw) ? indexRaw : [indexRaw]).map(Number);
      items = idxs
        .filter(i => Number.isInteger(i) && i >= 0 && i < input.length)
        .map(i => input[i]);
    } else {
      items = input.slice(skip);
      if (skipLast > 0) items = items.slice(0, Math.max(0, items.length - skipLast));
      if (first !== undefined) items = items.slice(0, Math.max(0, first));
      if (last  !== undefined) items = last <= 0 ? [] : items.slice(-last);
    }

    if (unique) {
      const seen = new Set<string>();
      items = items.filter(item => {
        const key = JSON.stringify(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    if (expandProp) {
      return items.map(item => {
        const src = item as Record<string, PSValue>;
        const key = Object.keys(src).find(k => k.toLowerCase() === expandProp.toLowerCase()) ?? expandProp;
        return src[key] ?? null;
      });
    }

    if (rawProps.length === 0) return items;

    // Build a column plan in the ORDER the user listed them — string
    // props and calculated props interleaved (real PowerShell keeps
    // `Select-Object @{...}, Status` as Svc-then-Status, not regrouped).
    type Col =
      | { kind: 'prop'; name: string }
      | { kind: 'calc'; name: string; expr: PSScriptBlock };
    const sampleKeys = items[0] !== null && typeof items[0] === 'object' && !Array.isArray(items[0])
      ? Object.keys(items[0] as Record<string, PSValue>)
      : [];
    const cols: Col[] = [];
    for (const p of rawProps) {
      if (typeof p === 'string') {
        if (p === '*') {
          for (const k of sampleKeys) cols.push({ kind: 'prop', name: k });
        } else {
          cols.push({ kind: 'prop', name: p });
        }
      } else if (p && typeof p === 'object' && !Array.isArray(p)) {
        const h = p as Record<string, PSValue>;
        const name = psValueToString(h['Name'] ?? h['name'] ?? h['N'] ?? h['n'] ?? '');
        const expr = (h['Expression'] ?? h['expression'] ?? h['E'] ?? h['e']) as PSScriptBlock;
        if (name && expr) cols.push({ kind: 'calc', name, expr });
      }
    }

    return items.map(item => {
      const src = item as Record<string, PSValue>;
      const out: Record<string, PSValue> = {};
      for (const col of cols) {
        if (col.kind === 'prop') {
          const key = Object.keys(src).find(k => k.toLowerCase() === col.name.toLowerCase()) ?? col.name;
          out[key] = src[key] ?? null;
        } else {
          out[col.name] = ctx.invokeBlock(col.expr, item);
        }
      }
      return out;
    });
  }
}

// ─── Sort-Object ──────────────────────────────────────────────────────────

export class SortObjectCmdlet implements ICmdlet {
  readonly name = 'sort-object';
  readonly parameters = ['Property', 'InputObject', 'Descending', 'Unique', 'CaseSensitive', 'Culture', 'Stable', 'Top', 'Bottom'] as const;
  readonly aliases = ['sort'] as const;

  execute(ctx: CmdletContext): PSValue {
    const input   = toArray(ctx.pipeInput);
    const desc    = isTruthy(ctx.named['descending'] ?? false);
    const uniq    = isTruthy(ctx.named['unique'] ?? false);
    const ci      = !isTruthy(ctx.named['casesensitive'] ?? false);
    const top     = ctx.named['top']    !== undefined ? Number(ctx.named['top'])    : undefined;
    const bottom  = ctx.named['bottom'] !== undefined ? Number(ctx.named['bottom']) : undefined;

    // Support multi-property sort: `Sort-Object Status, Name`.
    const keysRaw = ctx.named['property'] !== undefined
      ? toArray(ctx.named['property'])
      : (ctx.positional.length ? flattenProps(ctx.positional) : []);
    const keyArgs: PSValue[] = keysRaw.length ? keysRaw : [null];

    const keyVal = (item: PSValue, keyArg: PSValue): PSValue => {
      if (keyArg === null || keyArg === undefined) return item;
      if (typeof keyArg === 'object' && (keyArg as Record<string, unknown>).type === 'ScriptBlock') {
        return ctx.invokeBlock(keyArg as PSScriptBlock, item);
      }
      const prop = psValueToString(keyArg);
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const rec = item as Record<string, PSValue>;
        const k = Object.keys(rec).find(x => x.toLowerCase() === prop.toLowerCase());
        return k !== undefined ? rec[k] : null;
      }
      if (typeof item === 'string' && prop.toLowerCase() === 'length') return item.length;
      if (Array.isArray(item) && (prop.toLowerCase() === 'length' || prop.toLowerCase() === 'count'))
        return (item as PSValue[]).length;
      return item;
    };

    const cmp1 = (av: PSValue, bv: PSValue): number => {
      const an = Number(av), bn = Number(bv);
      const bothNum = !isNaN(an) && !isNaN(bn)
        && av !== null && av !== '' && bv !== null && bv !== '';
      if (bothNum) return an - bn;
      const as = String(av ?? ''), bs = String(bv ?? '');
      return ci ? as.toLowerCase().localeCompare(bs.toLowerCase())
                : as.localeCompare(bs);
    };

    // Stable multi-key sort (PowerShell's Sort-Object is stable).
    const sorted = input
      .map((v, i) => [v, i] as [PSValue, number])
      .sort(([a, ia], [b, ib]) => {
        for (const ka of keyArgs) {
          const c = cmp1(keyVal(a, ka), keyVal(b, ka));
          if (c !== 0) return desc ? -c : c;
        }
        return ia - ib; // stable
      })
      .map(([v]) => v);

    let result: PSValue[] = sorted;
    if (uniq) {
      const seen = new Set<string>();
      result = sorted.filter(item => {
        const key = keyArgs.map(k => psValueToString(keyVal(item, k))).join('');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    if (top    !== undefined) return result.slice(0, Math.max(0, top));
    if (bottom !== undefined) return bottom <= 0 ? [] : result.slice(-bottom);
    return result;
  }
}

// ─── Measure-Object ───────────────────────────────────────────────────────

export class MeasureObjectCmdlet implements ICmdlet {
  readonly name = 'measure-object';
  readonly parameters = ['Property', 'InputObject', 'Sum', 'Average', 'Maximum', 'Minimum', 'StandardDeviation', 'Line', 'Word', 'Character', 'AllStats'] as const;
  readonly aliases = ['measure'] as const;

  execute(ctx: CmdletContext): PSValue {
    const input = toArray(ctx.pipeInput);
    const props = stringArgs(ctx.positional, ctx.named, 'property');
    // Numeric values for Sum/Average/Min/Max (a property, or the item
    // itself when no -Property given). Count, below, is the number of
    // input objects — NOT just the numeric ones — so
    // `Get-Command | Measure-Object` reports every command.
    const rawValues = input.map(item =>
      props.length ? (item as Record<string, PSValue>)[props[0]] : item,
    );
    const nums = rawValues.map(v => Number(v)).filter(n => !isNaN(n));

    const wantSum = isTruthy(ctx.named['sum']     ?? false);
    const wantAvg = isTruthy(ctx.named['average'] ?? false);
    const wantMin = isTruthy(ctx.named['minimum'] ?? ctx.named['min'] ?? false);
    const wantMax = isTruthy(ctx.named['maximum'] ?? ctx.named['max'] ?? false);

    const result: Record<string, PSValue> = { Count: input.length };
    result['Sum']     = wantSum  ? nums.reduce((a, b) => a + b, 0) : null;
    result['Average'] = wantAvg  ? (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null) : null;
    result['Minimum'] = wantMin  ? (nums.length ? Math.min(...nums) : null) : null;
    result['Maximum'] = wantMax  ? (nums.length ? Math.max(...nums) : null) : null;
    result['Property'] = props[0] ?? null;

    return result;
  }
}

// ─── Group-Object ─────────────────────────────────────────────────────────

export class GroupObjectCmdlet implements ICmdlet {
  readonly name = 'group-object';
  readonly parameters = ['Property', 'InputObject', 'NoElement', 'AsHashTable', 'AsString', 'CaseSensitive', 'Culture'] as const;
  readonly aliases = ['group'] as const;

  execute(ctx: CmdletContext): PSValue {
    const input = toArray(ctx.pipeInput);
    const noElement = isTruthy(ctx.named['noelement'] ?? false);

    const keyArg = ctx.named['property'] ?? ctx.positional[0];
    const sb = isScriptBlockVal(keyArg) ? (keyArg as PSScriptBlock) : null;
    const props = sb ? [] : stringArgs(ctx.positional, ctx.named, 'property');

    const keyOf = (item: PSValue): string => {
      if (sb) return psValueToString(ctx.invokeBlock(sb, item));
      if (props.length === 0) return psValueToString(item);
      // Multi-property keys join with ", " (matches real Group-Object).
      const rec = item as Record<string, PSValue>;
      return props.map(p => {
        const k = Object.keys(rec).find(x => x.toLowerCase() === p.toLowerCase());
        return psValueToString(k ? rec[k] : null);
      }).join(', ');
    };

    const groups: Record<string, PSValue[]> = {};
    for (const item of input) {
      const key = keyOf(item);
      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
    }

    return Object.entries(groups).map(([k, v]) => {
      const obj: Record<string, PSValue> = { Name: k, Count: v.length };
      if (!noElement) obj['Group'] = v;
      return obj;
    });
  }
}

// ─── Get-Unique ───────────────────────────────────────────────────────────

export class GetUniqueCmdlet implements ICmdlet {
  readonly name = 'get-unique';
  readonly aliases = ['gu'] as const;

  execute(ctx: CmdletContext): PSValue {
    const arr = toArray(ctx.pipeInput);
    const out: PSValue[] = [];
    let prev: string | null = null;
    for (const v of arr) {
      const key = psValueToString(v);
      if (key !== prev) { out.push(v); prev = key; }
    }
    return out;
  }
}

// ─── Tee-Object ───────────────────────────────────────────────────────────

export class TeeObjectCmdlet implements ICmdlet {
  readonly name = 'tee-object';
  readonly parameters = ['FilePath', 'LiteralPath', 'InputObject', 'Append', 'Variable'] as const;
  readonly aliases = ['tee'] as const;

  execute(ctx: CmdletContext): PSValue {
    const vname = psValueToString(ctx.named['variable'] ?? ctx.positional[0] ?? '');
    if (vname) ctx.env.set(vname, ctx.pipeInput ?? null);
    return ctx.pipeInput ?? null;
  }
}

// ─── Compare-Object ───────────────────────────────────────────────────────

export class CompareObjectCmdlet implements ICmdlet {
  readonly name = 'compare-object';
  readonly parameters = ['ReferenceObject', 'DifferenceObject', 'Property', 'IncludeEqual', 'ExcludeDifferent', 'PassThru', 'CaseSensitive'] as const;
  readonly aliases = ['diff', 'compare'] as const;

  execute(ctx: CmdletContext): PSValue {
    const ref          = toArray(ctx.named['referenceobject']);
    const diff         = toArray(ctx.named['differenceobject'] ?? ctx.positional[0]);
    const includeEqual = isTruthy(ctx.named['includeequal'] ?? false);

    const out: Record<string, PSValue>[] = [];
    const refSet  = new Set(ref.map(v => psValueToString(v)));
    const diffSet = new Set(diff.map(v => psValueToString(v)));

    for (const v of ref)  if (!diffSet.has(psValueToString(v))) out.push({ InputObject: v, SideIndicator: '<=' });
    for (const v of diff) if (!refSet.has(psValueToString(v)))  out.push({ InputObject: v, SideIndicator: '=>' });
    if (includeEqual) {
      for (const v of ref) if (diffSet.has(psValueToString(v))) out.push({ InputObject: v, SideIndicator: '==' });
    }
    return out;
  }
}

// ─── Select-String ────────────────────────────────────────────────────────

export class SelectStringCmdlet implements ICmdlet {
  readonly name = 'select-string';
  readonly parameters = ['Pattern', 'Path', 'LiteralPath', 'InputObject', 'SimpleMatch', 'CaseSensitive', 'Quiet', 'List', 'NotMatch', 'AllMatches', 'Context'] as const;
  readonly aliases = ['sls'] as const;

  execute(ctx: CmdletContext): PSValue {
    const patterns    = stringArgs(ctx.positional, ctx.named, 'pattern');
    const pat         = patterns[0] ?? '';
    const simple      = isTruthy(ctx.named['simplematch'] ?? false);
    const notMatch    = isTruthy(ctx.named['notmatch']    ?? false);
    const caseSens    = isTruthy(ctx.named['casesensitive'] ?? false);
    const input       = toArray(ctx.pipeInput);

    const escaped = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = simple
      ? new RegExp(escaped,  caseSens ? '' : 'i')
      : new RegExp(pat,      caseSens ? '' : 'i');

    const matches: Record<string, PSValue>[] = [];
    for (const item of input) {
      const line = psValueToString(item);
      const hit  = re.test(line);
      if (hit !== notMatch) {
        matches.push({ Line: line, Pattern: pat, LineNumber: matches.length + 1 });
      }
    }
    return matches;
  }
}

// ─── Format-Table / Format-List / Format-Wide / Format-Custom ────────────

export class FormatTableCmdlet implements ICmdlet {
  readonly name = 'format-table';
  readonly parameters = ['Property', 'AutoSize', 'Wrap', 'GroupBy', 'HideTableHeaders', 'InputObject', 'Force', 'RepeatHeader'] as const;
  readonly aliases = ['ft'] as const;

  execute(ctx: CmdletContext): PSValue {
    const items = toArray(ctx.pipeInput);
    if (items.length === 0) return '';
    const sample = items[0];
    const rawProps = flattenProps(ctx.named['property'] !== undefined
      ? toArray(ctx.named['property'])
      : ctx.positional);
    let cols = resolveColumns(rawProps, sample, ctx);
    if (cols.length === 0) {
      const keys = sample !== null && typeof sample === 'object' && !Array.isArray(sample)
        ? Object.keys(sample as Record<string, PSValue>)
        : ['Value'];
      cols = keys.map(k => ({ name: k, get: (it: PSValue) => pickProp(it, k) }));
    }
    const hideHeaders = ctx.named['hidetableheaders'] === true;
    const colWidth = 15;
    const header = cols.map(c => c.name.padEnd(colWidth)).join(' ');
    const sep    = cols.map(() => '-'.repeat(colWidth)).join(' ');
    const rows   = items.map(item =>
      cols.map(c => psValueToString(c.get(item) ?? '').padEnd(colWidth)).join(' '));
    return (hideHeaders ? rows : [header, sep, ...rows]).join('\n');
  }
}

export class FormatListCmdlet implements ICmdlet {
  readonly name = 'format-list';
  readonly parameters = ['Property', 'GroupBy', 'InputObject', 'Force', 'Expand'] as const;
  readonly aliases = ['fl'] as const;

  execute(ctx: CmdletContext): PSValue {
    const items = toArray(ctx.pipeInput);
    const rawProps = flattenProps(ctx.named['property'] !== undefined
      ? toArray(ctx.named['property'])
      : ctx.positional);
    return items.map(item => {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const src = item as Record<string, PSValue>;
        let cols = resolveColumns(rawProps, item, ctx);
        if (cols.length === 0) {
          cols = Object.keys(src).map(k => ({ name: k, get: (it: PSValue) => pickProp(it, k) }));
        }
        return cols.map(c => `${c.name} : ${psValueToString(c.get(item) ?? '')}`).join('\n');
      }
      return psValueToString(item);
    }).join('\n\n');
  }
}

export class FormatWideCmdlet implements ICmdlet {
  readonly name = 'format-wide';
  readonly aliases = ['fw'] as const;

  execute(ctx: CmdletContext): PSValue {
    const items = toArray(ctx.pipeInput);
    const cols  = Number(ctx.named['column'] ?? ctx.named['columns'] ?? 4) || 4;
    // -Property (positional or named): the single column to display.
    // Default for objects is the canonical display prop (Name) or first
    // key — NOT the whole "Key=Value;" object dump.
    const propArg = stringArgs(ctx.positional, ctx.named, 'property');
    const prop = propArg.length ? propArg[0] : null;

    const cellOf = (v: PSValue): string => {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const rec = v as Record<string, PSValue>;
        if (prop) {
          const k = Object.keys(rec).find(x => x.toLowerCase() === prop.toLowerCase());
          return psValueToString(k !== undefined ? rec[k] : '');
        }
        const nameK = Object.keys(rec).find(x => x.toLowerCase() === 'name');
        return psValueToString(nameK !== undefined ? rec[nameK] : (Object.values(rec)[0] ?? ''));
      }
      return psValueToString(v);
    };

    const cells = items.map(cellOf);
    const width = Math.max(1, ...cells.map(c => c.length)) + 2;
    const lines: string[] = [];
    for (let i = 0; i < cells.length; i += cols) {
      lines.push(cells.slice(i, i + cols).map(c => c.padEnd(width)).join('').replace(/\s+$/, ''));
    }
    return lines.join('\n');
  }
}

export class FormatCustomCmdlet implements ICmdlet {
  readonly name = 'format-custom';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    return toArray(ctx.pipeInput).map(v => psValueToString(v)).join('\n');
  }
}


// ─── Get-Member ───────────────────────────────────────────────────────────

export class GetMemberCmdlet implements ICmdlet {
  readonly name = 'get-member';
  readonly parameters = ['Name', 'InputObject', 'MemberType', 'Static', 'Force', 'View'] as const;
  readonly aliases = ['gm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const input = toArray(ctx.named['inputobject'] ?? ctx.pipeInput);
    if (input.length === 0) return [];
    const sample = input[0];
    const filter = ctx.named['membertype'] ? psValueToString(ctx.named['membertype']).toLowerCase() : null;
    const nameF  = ctx.named['name'] ? psValueToString(ctx.named['name']).toLowerCase() : null;

    type Mem = { Name: string; MemberType: string; Definition: string };
    let members: Mem[];

    if (typeof sample === 'string') {
      // .NET System.String surface — enough that `"x" | Get-Member -Name
      // Substring` resolves (was dumping per-char index "properties").
      members = [
        { Name: 'Length', MemberType: 'Property', Definition: 'int Length {get;}' },
        ...['Contains', 'EndsWith', 'IndexOf', 'Insert', 'PadLeft', 'PadRight',
            'Remove', 'Replace', 'Split', 'StartsWith', 'Substring', 'ToCharArray',
            'ToLower', 'ToUpper', 'Trim', 'TrimEnd', 'TrimStart']
          .map(m => ({ Name: m, MemberType: 'Method', Definition: `string ${m}()` })),
      ];
    } else if (typeof sample === 'number' || typeof sample === 'boolean') {
      members = ['CompareTo', 'Equals', 'GetHashCode', 'GetType', 'ToString']
        .map(m => ({ Name: m, MemberType: 'Method', Definition: `${typeof sample} ${m}()` }));
    } else if (sample !== null && typeof sample === 'object' && !Array.isArray(sample)) {
      const rec = sample as Record<string, PSValue>;
      // A [pscustomobject] exposes NoteProperty members; a plain hashtable
      // exposes Property members (psCast tags the former).
      const propKind = (rec as Record<string, unknown>).__pscustomobject__
        ? 'NoteProperty' : 'Property';
      members = Object.keys(rec)
        .filter(k => !k.startsWith('__'))
        .map(k => typeof rec[k] === 'function'
          ? { Name: k, MemberType: 'Method',   Definition: `System.Object ${k}()` }
          : { Name: k, MemberType: propKind,   Definition: `${typeof rec[k]} ${k}` });
    } else {
      members = [];
    }

    const matchType = (mt: string) => !filter || mt.toLowerCase() === filter;

    return members
      .filter(m => matchType(m.MemberType))
      .filter(m => !nameF || m.Name.toLowerCase() === nameF)
      .map(m => ({ ...m })) as PSValue[];
  }
}
