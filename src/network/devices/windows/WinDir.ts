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
  let targetPath: string | null = null;

  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === '/w') flags.add('wide');
    else if (lower === '/s') flags.add('recursive');
    else if (lower === '/b') flags.add('bare');
    else if (lower === '/?') return dirHelp();
    else targetPath = arg;
  }

  const absPath = targetPath
    ? ctx.fs.normalizePath(targetPath, ctx.cwd)
    : ctx.cwd;

  if (!ctx.fs.isDirectory(absPath)) {
    return 'File Not Found';
  }

  if (flags.has('recursive')) {
    return dirRecursive(ctx, absPath, flags);
  }

  return dirSingle(ctx, absPath, flags);
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
