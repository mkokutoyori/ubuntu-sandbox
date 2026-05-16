/**
 * Windows DIR command — lists files and directories.
 *
 * Behavior (matching real Windows 10/11):
 *   dir              → list current directory
 *   dir <path>       → list specified directory
 *   dir /w           → wide format
 *   dir /s           → recursive listing
 *   dir /s /b        → bare recursive listing (paths only)
 */

import type { WinFileCommandContext } from './WinFileCommands';

export function cmdDir(ctx: WinFileCommandContext, args: string[]): string {
  const flags = new Set<string>();
  const positionals: string[] = [];

  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === '/w') flags.add('wide');
    else if (lower === '/s') flags.add('recursive');
    else if (lower === '/b') flags.add('bare');
    else if (lower === '/?') return dirHelp();
    // `/a` shows all attributes, `/a:<spec>` filters; `/o:<spec>` sorts.
    // The simulator does not store dates per attribute filter, so we accept
    // these flags as no-ops rather than failing with "File Not Found".
    else if (lower === '/a' || lower.startsWith('/a:')) flags.add('all-attrs');
    else if (lower === '/o' || lower.startsWith('/o:') || lower.startsWith('/od')) flags.add('sort');
    else if (lower.startsWith('/')) continue;
    else positionals.push(arg);
  }

  // First positional = directory (may be omitted), second = wildcard.
  // `dir C:\CohFs *.txt` → dir=C:\CohFs, pattern=*.txt.
  let targetPath: string | null = positionals[0] ?? null;
  if (positionals.length >= 2 && /[*?]/.test(positionals[1])) {
    targetPath = positionals[0];
  }

  // Split a `<dir> <pattern>` form: real cmd accepts both
  // `dir C:\CohFs *.txt` (two args) and `dir C:\CohFs\*.txt` (one path).
  let wildcard: string | null = null;
  if (positionals.length >= 2 && /[*?]/.test(positionals[positionals.length - 1])) {
    wildcard = positionals[positionals.length - 1];
  } else if (targetPath && /[*?]/.test(targetPath)) {
    const sep = Math.max(targetPath.lastIndexOf('\\'), targetPath.lastIndexOf('/'));
    wildcard = targetPath.slice(sep + 1);
    targetPath = sep >= 0 ? targetPath.slice(0, sep + 1) : ctx.cwd;
  }

  const absPath = targetPath
    ? ctx.fs.normalizePath(targetPath, ctx.cwd)
    : ctx.cwd;

  // `dir <file>` is valid on real Windows: list the file as a one-row entry
  // inside its parent directory. Only return "File Not Found" when nothing
  // at that path exists.
  if (!ctx.fs.isDirectory(absPath)) {
    if (!ctx.fs.exists(absPath)) return 'File Not Found';
    return dirSingleFile(ctx, absPath);
  }
  if (wildcard) {
    return dirWildcard(ctx, absPath, wildcard);
  }

  // `/b` — bare format: names only, no header / summary / . / .. .
  // Equivalent in meaning to PowerShell `Get-ChildItem -Name`.
  if (flags.has('bare')) {
    return dirBare(ctx, absPath, flags.has('recursive'));
  }

  if (flags.has('recursive')) {
    return dirRecursive(ctx, absPath, flags);
  }

  return dirSingle(ctx, absPath, flags);
}

/**
 * `dir /b` — one name per line, no decoration. `dir /s /b` lists full
 * absolute paths recursively. Sort order matches the normal listing
 * (directories then files, each alphabetical) so it stays coherent
 * with `Get-ChildItem -Name`.
 */
function dirBare(ctx: WinFileCommandContext, absPath: string, recursive: boolean): string {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    const entries = ctx.fs.listDirectory(dir);
    for (const { name, entry } of entries) {
      out.push(recursive ? `${dir}\\${name}` : (prefix ? `${prefix}\\${name}` : name));
      if (recursive && entry.type === 'directory') {
        walk(`${dir}\\${name}`, '');
      }
    }
  };
  walk(absPath, '');
  // Real cmd prints nothing (and sets errorlevel) when the dir is empty.
  return out.join('\n');
}

function dirWildcard(ctx: WinFileCommandContext, absPath: string, pattern: string): string {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  const entries = ctx.fs.listDirectory(absPath).filter(e => re.test(e.name));
  if (entries.length === 0) return 'File Not Found';
  const lines: string[] = [];
  lines.push(` Volume in drive ${absPath[0]} has no label.`);
  lines.push(` Volume Serial Number is ${ctx.fs.getVolumeSerialNumber()}`);
  lines.push('');
  lines.push(` Directory of ${absPath}`);
  lines.push('');
  let fileCount = 0;
  let fileBytes = 0;
  let dirCount  = 0;
  for (const { name, entry } of entries) {
    const date = formatDate(entry.mtime);
    if (entry.type === 'directory') {
      lines.push(`${date}    <DIR>          ${name}`);
      dirCount++;
    } else {
      const sizeStr = entry.size.toLocaleString('en-US').padStart(14, ' ');
      lines.push(`${date} ${sizeStr} ${name}`);
      fileCount++;
      fileBytes += entry.size;
    }
  }
  lines.push(`               ${fileCount} File(s) ${fileBytes.toLocaleString('en-US')} bytes`);
  lines.push(`               ${dirCount} Dir(s)  53,687,091,200 bytes free`);
  return lines.join('\n');
}

function dirSingleFile(ctx: WinFileCommandContext, absPath: string): string {
  const lastSep = absPath.lastIndexOf('\\');
  const parent  = lastSep > 1 ? absPath.slice(0, lastSep) : absPath.slice(0, lastSep + 1);
  const leaf    = absPath.slice(lastSep + 1);
  const entries = ctx.fs.listDirectory(parent);
  const hit = entries.find(e => e.name.toLowerCase() === leaf.toLowerCase());
  if (!hit) return 'File Not Found';
  const lines: string[] = [];
  lines.push(` Volume in drive ${absPath[0]} has no label.`);
  lines.push(` Volume Serial Number is ${ctx.fs.getVolumeSerialNumber()}`);
  lines.push('');
  lines.push(` Directory of ${parent}`);
  lines.push('');
  const date = formatDate(hit.entry.mtime);
  const sizeStr = hit.entry.size.toLocaleString('en-US').padStart(14, ' ');
  lines.push(`${date} ${sizeStr} ${hit.name}`);
  lines.push(`               1 File(s) ${hit.entry.size.toLocaleString('en-US')} bytes`);
  lines.push(`               0 Dir(s)  53,687,091,200 bytes free`);
  return lines.join('\n');
}

function dirSingle(ctx: WinFileCommandContext, absPath: string, flags: Set<string>): string {
  const entries = ctx.fs.listDirectory(absPath);
  const lines: string[] = [];

  // Volume header
  lines.push(` Volume in drive ${absPath[0]} has no label.`);
  lines.push(` Volume Serial Number is ${ctx.fs.getVolumeSerialNumber()}`);
  lines.push('');
  lines.push(` Directory of ${absPath}`);
  lines.push('');

  if (flags.has('wide')) {
    return dirWide(ctx, absPath, entries, lines);
  }

  // Add . and .. entries
  const parentPath = absPath.substring(0, absPath.lastIndexOf('\\'));
  const dotDate = formatDate(new Date());
  lines.push(`${dotDate}    <DIR>          .`);
  lines.push(`${dotDate}    <DIR>          ..`);

  let fileCount = 0;
  let fileBytes = 0;
  let dirCount = 2; // . and ..

  for (const { name, entry } of entries) {
    const date = formatDate(entry.mtime);
    if (entry.type === 'directory') {
      lines.push(`${date}    <DIR>          ${name}`);
      dirCount++;
    } else {
      const sizeStr = entry.size.toLocaleString('en-US').padStart(14, ' ');
      lines.push(`${date} ${sizeStr} ${name}`);
      fileCount++;
      fileBytes += entry.size;
    }
  }

  lines.push(`               ${fileCount} File(s) ${fileBytes.toLocaleString('en-US')} bytes`);
  lines.push(`               ${dirCount} Dir(s)  ${ctx.fs.getFreeDiskSpace().toLocaleString('en-US')} bytes free`);
  return lines.join('\n');
}

function dirWide(
  ctx: WinFileCommandContext,
  absPath: string,
  entries: { name: string; entry: any }[],
  lines: string[]
): string {
  // Wide format: [DirName] or filename, columns
  const items: string[] = ['.', '..'];
  for (const { name, entry } of entries) {
    items.push(entry.type === 'directory' ? `[${name}]` : name);
  }

  const colWidth = 20;
  const cols = 4;
  for (let i = 0; i < items.length; i += cols) {
    const row = items.slice(i, i + cols).map(s => s.padEnd(colWidth)).join('');
    lines.push(row);
  }

  let fileCount = 0, fileBytes = 0, dirCount = 2;
  for (const { entry } of entries) {
    if (entry.type === 'directory') dirCount++;
    else { fileCount++; fileBytes += entry.size; }
  }
  lines.push(`               ${fileCount} File(s) ${fileBytes.toLocaleString('en-US')} bytes`);
  lines.push(`               ${dirCount} Dir(s)  ${ctx.fs.getFreeDiskSpace().toLocaleString('en-US')} bytes free`);
  return lines.join('\n');
}

function dirRecursive(ctx: WinFileCommandContext, absPath: string, flags: Set<string>): string {
  const allDirs = ctx.fs.listDirectoryRecursive(absPath);
  const lines: string[] = [];

  // Volume header
  lines.push(` Volume in drive ${absPath[0]} has no label.`);
  lines.push(` Volume Serial Number is ${ctx.fs.getVolumeSerialNumber()}`);
  lines.push('');

  let totalFiles = 0, totalBytes = 0, totalDirs = 0;

  for (const { path, entries } of allDirs) {
    lines.push(` Directory of ${path}`);
    lines.push('');

    const dotDate = formatDate(new Date());
    lines.push(`${dotDate}    <DIR>          .`);
    lines.push(`${dotDate}    <DIR>          ..`);

    let fileCount = 0, fileBytes = 0, dirCount = 2;
    for (const { name, entry } of entries) {
      const date = formatDate(entry.mtime);
      if (entry.type === 'directory') {
        lines.push(`${date}    <DIR>          ${name}`);
        dirCount++;
      } else {
        const sizeStr = entry.size.toLocaleString('en-US').padStart(14, ' ');
        lines.push(`${date} ${sizeStr} ${name}`);
        fileCount++;
        fileBytes += entry.size;
      }
    }
    lines.push(`               ${fileCount} File(s) ${fileBytes.toLocaleString('en-US')} bytes`);
    lines.push(`               ${dirCount} Dir(s)  ${ctx.fs.getFreeDiskSpace().toLocaleString('en-US')} bytes free`);
    lines.push('');

    totalFiles += fileCount;
    totalBytes += fileBytes;
    totalDirs += dirCount;
  }

  lines.push(`     Total Files Listed:`);
  lines.push(`               ${totalFiles} File(s) ${totalBytes.toLocaleString('en-US')} bytes`);
  lines.push(`               ${totalDirs} Dir(s)  ${ctx.fs.getFreeDiskSpace().toLocaleString('en-US')} bytes free`);
  return lines.join('\n');
}

function formatDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  let hh = d.getHours();
  const ampm = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd}/${yyyy}  ${String(hh).padStart(2, '0')}:${min} ${ampm}`;
}

function dirHelp(): string {
  return [
    'Displays a list of files and subdirectories in a directory.',
    '',
    'DIR [drive:][path][filename] [/W] [/S] [/B]',
    '',
    '  /W   Uses wide list format.',
    '  /S   Displays files in specified directory and all subdirectories.',
    '  /B   Uses bare format (no heading information or summary).',
  ].join('\n');
}
