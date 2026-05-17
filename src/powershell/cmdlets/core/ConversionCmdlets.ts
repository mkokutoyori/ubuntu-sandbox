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

    const delim = ctx.named['delimiter'] !== undefined
      ? psValueToString(ctx.named['delimiter']) : ',';
    const first   = arr[0] as Record<string, PSValue>;
    const headers = Object.keys(first);
    const lines: string[] = [];
    if (ctx.named['notypeinformation'] !== true) {
      lines.push('#TYPE System.Management.Automation.PSCustomObject');
    }
    lines.push(headers.map(h => `"${h}"`).join(delim));
    for (const row of arr) {
      const r = row as Record<string, PSValue>;
      lines.push(headers.map(h => `"${psValueToString(r[h] ?? '')}"`).join(delim));
    }
    return lines;
  }
}

// ─── ConvertFrom-Csv ──────────────────────────────────────────────────────

export class ConvertFromCsvCmdlet implements ICmdlet {
  readonly name = 'convertfrom-csv';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const delim = ctx.named['delimiter'] !== undefined
      ? psValueToString(ctx.named['delimiter']) : ',';
    // Flatten input: a single multi-line string (here-string / `\n`-joined)
    // OR an array of line strings — both are valid CSV input in PS.
    const lines = toArray(ctx.pipeInput)
      .flatMap(v => psValueToString(v).split(/\r?\n/))
      .filter(l => l.length > 0);

    // -Header lets the data start at line 0 (no header row in the text).
    const headerOpt = ctx.named['header'];
    let headers: string[];
    let dataStart: number;
    if (headerOpt !== undefined && headerOpt !== null) {
      headers = (Array.isArray(headerOpt)
        ? headerOpt.map(psValueToString)
        : psValueToString(headerOpt).split(delim).map(s => s.trim()));
      dataStart = 0;
    } else {
      if (lines.length < 1) return [];
      headers = parseCsvLine(lines[0], delim);
      dataStart = 1;
    }

    const rows: Record<string, PSValue>[] = [];
    for (let i = dataStart; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i], delim);
      const obj: Record<string, PSValue> = {};
      headers.forEach((h, j) => { obj[h] = cells[j] ?? ''; });
      rows.push(obj);
    }
    return rows;
  }
}

function parseCsvLine(line: string, delim: string = ','): string[] {
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
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
