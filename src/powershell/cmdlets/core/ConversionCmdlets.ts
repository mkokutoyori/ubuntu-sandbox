/**
 * ConversionCmdlets — Data format conversion cmdlets.
 *
 * ConvertTo/From-Json, ConvertTo/From-Csv.
 * No system providers required.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

function toArray(val: PSValue): PSValue[] {
  if (val === null || val === undefined) return [];
  return Array.isArray(val) ? val : [val];
}

// ─── ConvertTo-Json ────────────────────────────────────────────────────────

export class ConvertToJsonCmdlet implements ICmdlet {
  readonly name = 'convertto-json';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const val    = ctx.pipeInput ?? ctx.positional[0] ?? null;
    const depth  = ctx.named['depth'] !== undefined ? Number(ctx.named['depth']) : undefined;
    const compress = ctx.named['compress'] === true;
    return compress
      ? JSON.stringify(val)
      : JSON.stringify(val, null, depth !== undefined ? depth : 2);
  }
}

// ─── ConvertFrom-Json ─────────────────────────────────────────────────────

export class ConvertFromJsonCmdlet implements ICmdlet {
  readonly name = 'convertfrom-json';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const src = psValueToString(ctx.pipeInput ?? ctx.positional[0] ?? '');
    try { return JSON.parse(src) as PSValue; }
    catch { return null; }
  }
}

// ─── ConvertTo-Csv ────────────────────────────────────────────────────────

export class ConvertToCsvCmdlet implements ICmdlet {
  readonly name = 'convertto-csv';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const arr = toArray(ctx.pipeInput);
    if (arr.length === 0) return [];

    const first   = arr[0] as Record<string, PSValue>;
    const headers = Object.keys(first);
    const lines: string[] = [];
    if (ctx.named['notypeinformation'] !== true) lines.push('#TYPE Hashtable');
    lines.push(headers.map(h => `"${h}"`).join(','));
    for (const row of arr) {
      const r = row as Record<string, PSValue>;
      lines.push(headers.map(h => `"${psValueToString(r[h] ?? '')}"`).join(','));
    }
    return lines;
  }
}

// ─── ConvertFrom-Csv ──────────────────────────────────────────────────────

export class ConvertFromCsvCmdlet implements ICmdlet {
  readonly name = 'convertfrom-csv';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const lines = toArray(ctx.pipeInput).map(v => psValueToString(v));
    if (lines.length < 2) return [];
    const headers = parseCsvLine(lines[0]);
    const rows: Record<string, PSValue>[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i]);
      const obj: Record<string, PSValue> = {};
      headers.forEach((h, j) => { obj[h] = cells[j] ?? ''; });
      rows.push(obj);
    }
    return rows;
  }
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
