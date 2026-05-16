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
    const input  = toArray(ctx.pipeInput);
    const filter = (ctx.named['filterscript'] ?? ctx.positional[0]) as PSScriptBlock;
    if (!filter) return input;
    return input.filter(item => {
      const result = ctx.invokeBlock(filter, item);
      return isTruthy(result);
    });
  }
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

    if (begin)  collect(ctx.invokeBlock(begin,  null));
    if (script) {
      for (const item of input) collect(ctx.invokeBlock(script, item));
    }
    if (end)    collect(ctx.invokeBlock(end,    null));

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
    const unique     = ctx.named['unique'] === true;
    const expandProp = ctx.named['expandproperty'] !== undefined
      ? psValueToString(ctx.named['expandproperty']) : null;

    let items = input.slice(skip);
    if (first !== undefined) items = items.slice(0, first);
    if (last  !== undefined) items = items.slice(-last);

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

    // Separate string props from calculated props (hashtable with Name+Expression)
    const stringProps: string[] = [];
    const calcProps: Array<{ name: string; expr: PSScriptBlock }> = [];

    for (const p of rawProps) {
      if (typeof p === 'string') {
        stringProps.push(p);
      } else if (p && typeof p === 'object' && !Array.isArray(p)) {
        const h = p as Record<string, PSValue>;
        const name = psValueToString(h['Name'] ?? h['name'] ?? h['N'] ?? h['n'] ?? '');
        const expr = (h['Expression'] ?? h['expression'] ?? h['E'] ?? h['e']) as PSScriptBlock;
        if (name && expr) calcProps.push({ name, expr });
      }
    }

    return items.map(item => {
      const src = item as Record<string, PSValue>;
      const out: Record<string, PSValue> = {};
      for (const p of stringProps) {
        const key = Object.keys(src).find(k => k.toLowerCase() === p.toLowerCase()) ?? p;
        out[key] = src[key] ?? null;
      }
      for (const { name, expr } of calcProps) {
        out[name] = ctx.invokeBlock(expr, item);
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
    const keyArg  = ctx.named['property'] ?? ctx.positional[0] ?? null;

    const getKey = (item: PSValue): PSValue => {
      if (!keyArg) return item;
      if (keyArg && typeof keyArg === 'object' && (keyArg as Record<string, unknown>).type === 'ScriptBlock') {
        return ctx.invokeBlock(keyArg as PSScriptBlock, item);
      }
      const prop = psValueToString(keyArg);
      return (item as Record<string, PSValue>)[prop] ?? item;
    };

    const sorted = [...input].sort((a, b) => {
      const av = getKey(a);
      const bv = getKey(b);
      const an = Number(av);
      const bn = Number(bv);
      let cmp: number;
      if (!isNaN(an) && !isNaN(bn)) cmp = an - bn;
      else cmp = String(av).localeCompare(String(bv));
      return desc ? -cmp : cmp;
    });

    if (!uniq) return sorted;
    const seen = new Set<string>();
    return sorted.filter(item => {
      const key = psValueToString(getKey(item));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
    const props = stringArgs(ctx.positional, ctx.named, 'property');
    const noElement = isTruthy(ctx.named['noelement'] ?? false);

    const groups: Record<string, PSValue[]> = {};
    for (const item of input) {
      const key = props.length
        ? psValueToString((item as Record<string, PSValue>)[props[0]] ?? null)
        : psValueToString(item);
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
    const rawProps = stringArgs(ctx.positional, ctx.named, 'property');
    const props = rawProps.length ? rawProps : null;
    const sample = items[0];
    const keys = props ?? (
      sample && typeof sample === 'object' && !Array.isArray(sample)
        ? Object.keys(sample as Record<string, PSValue>)
        : ['Value']
    );
    const colWidth = 15;
    const header = keys.map(k => k.padEnd(colWidth)).join(' ');
    const sep    = keys.map(() => '-'.repeat(colWidth)).join(' ');
    const rows   = items.map(item => {
      const src = item && typeof item === 'object' && !Array.isArray(item)
        ? item as Record<string, PSValue> : { Value: item };
      return keys.map(k => {
        const val = src[Object.keys(src).find(x => x.toLowerCase() === k.toLowerCase()) ?? k] ?? '';
        return psValueToString(val).padEnd(colWidth);
      }).join(' ');
    });
    return [header, sep, ...rows].join('\n');
  }
}

export class FormatListCmdlet implements ICmdlet {
  readonly name = 'format-list';
  readonly parameters = ['Property', 'GroupBy', 'InputObject', 'Force', 'Expand'] as const;
  readonly aliases = ['fl'] as const;

  execute(ctx: CmdletContext): PSValue {
    const items = toArray(ctx.pipeInput);
    const propFilter = stringArgs(ctx.positional, ctx.named, 'property');
    return items.map(item => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const src = item as Record<string, PSValue>;
        const keys = Object.keys(src);
        const lcMap = new Map(keys.map(k => [k.toLowerCase(), k]));
        const picked = propFilter.length
          ? propFilter.map(p => [p, src[lcMap.get(p.toLowerCase()) ?? p] ?? ''] as [string, PSValue])
          : keys.map(k => [k, src[k]] as [string, PSValue]);
        return picked.map(([k, v]) => `${k} : ${psValueToString(v)}`).join('\n');
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
    const cols  = Number(ctx.named['column'] ?? ctx.named['columns'] ?? 4);
    const lines: string[] = [];
    for (let i = 0; i < items.length; i += cols) {
      lines.push(items.slice(i, i + cols).map(v => psValueToString(v).padEnd(18)).join(' '));
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
    const input = toArray(ctx.pipeInput);
    if (input.length === 0) return [];
    const sample = input[0] as Record<string, PSValue>;
    const filter = ctx.named['membertype'] ? psValueToString(ctx.named['membertype']).toLowerCase() : null;

    return Object.keys(sample).map(key => {
      const type = typeof sample[key] === 'function' ? 'Method' : 'Property';
      if (filter && type.toLowerCase() !== filter) return null;
      return { Name: key, MemberType: type, Definition: `${typeof sample[key]} ${key}` } as Record<string, PSValue>;
    }).filter(Boolean) as PSValue[];
  }
}
