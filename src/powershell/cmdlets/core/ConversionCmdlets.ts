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

function serializeCsv(arr: PSValue[], delim: string, noTypeInfo: boolean): string[] {
  if (arr.length === 0) return [];
  const first   = arr[0] as Record<string, PSValue>;
  const headers = Object.keys(first);
  const lines: string[] = [];
  if (!noTypeInfo) lines.push('#TYPE System.Management.Automation.PSCustomObject');
  lines.push(headers.map(h => `"${h}"`).join(delim));
  for (const row of arr) {
    const r = row as Record<string, PSValue>;
    lines.push(headers.map(h => `"${psValueToString(r[h] ?? '')}"`).join(delim));
  }
  return lines;
}

// ─── Export-Csv ───────────────────────────────────────────────────────────

export class ExportCsvCmdlet implements ICmdlet {
  readonly name = 'export-csv';
  readonly displayName = 'Export-Csv';
  readonly parameters = ['Path', 'LiteralPath', 'Delimiter', 'NoTypeInformation', 'Append', 'Encoding', 'Force'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = psValueToString(ctx.named['path'] ?? ctx.named['literalpath'] ?? ctx.positional[0] ?? '');
    if (!path) { ctx.emitError('Export-Csv requires -Path'); return null; }
    const fs = ctx.providers.filesystem;
    if (!fs) { ctx.emitError('Export-Csv: no filesystem provider in this context'); return null; }
    const delim = ctx.named['delimiter'] !== undefined ? psValueToString(ctx.named['delimiter']) : ',';
    const noTypeInfo = ctx.named['notypeinformation'] === true || ctx.named['notypeinformation'] === 'true';
    const arr = toArray(ctx.pipeInput ?? ctx.positional[1] ?? ctx.named['inputobject']);
    const lines = serializeCsv(arr, delim, noTypeInfo);
    const text = lines.join('\n') + (lines.length > 0 ? '\n' : '');
    if ((ctx.named['append'] === true || ctx.named['append'] === 'true')) {
      const existing = (() => { try { return fs.readFile(path); } catch { return ''; } })();
      if (existing.length > 0) {
        const body = noTypeInfo ? lines.slice(1) : lines.slice(2);
        fs.appendFile(path, body.join('\n') + '\n');
        return null;
      }
    }
    try {
      fs.writeFile(path, text);
    } catch (e) {
      ctx.emitError(`Export-Csv : ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
  }
}

function csvRows(
  lines: readonly string[], headers: readonly string[], dataStart: number, delim: string,
): Record<string, PSValue>[] {
  const rows: Record<string, PSValue>[] = [];
  for (let i = dataStart; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i], delim);
    const obj: Record<string, PSValue> = {};
    headers.forEach((h, j) => { obj[h] = cells[j] ?? ''; });
    rows.push(obj);
  }
  return rows;
}

function csvHeaderOption(raw: PSValue, delim: string): string[] | null {
  if (raw === undefined || raw === null) return null;
  return Array.isArray(raw) ? raw.map(psValueToString) : psValueToString(raw).split(delim).map(v => v.trim());
}

export class ImportCsvCmdlet implements ICmdlet {
  readonly name = 'import-csv';
  readonly displayName = 'Import-Csv';
  readonly parameters = ['Path', 'LiteralPath', 'Delimiter', 'Header', 'Encoding'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const path = psValueToString(ctx.named['path'] ?? ctx.named['literalpath'] ?? ctx.positional[0] ?? '');
    if (!path) { ctx.emitError('Import-Csv : Cannot process command because of one or more missing mandatory parameters: Path.'); return null; }
    const fs = ctx.providers.filesystem;
    if (!fs) { ctx.emitError('Import-Csv: no filesystem provider in this context'); return null; }
    let text: string;
    try { text = fs.readFile(path); }
    catch { ctx.emitError(`Import-Csv : Could not find file '${path}'.`); return null; }
    const delim = ctx.named['delimiter'] !== undefined ? psValueToString(ctx.named['delimiter']) : ',';
    const lines = text.split(/\r?\n/).filter(l => l.length > 0 && !l.startsWith('#TYPE'));
    const declared = csvHeaderOption(ctx.named['header'], delim);
    if (declared) return csvRows(lines, declared, 0, delim) as PSValue;
    if (lines.length === 0) return [];
    return csvRows(lines, parseCsvLine(lines[0], delim), 1, delim) as PSValue;
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

    return csvRows(lines, headers, dataStart, delim);
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
