/**
 * Windows file command context and file operation commands.
 *
 * Context interface for file commands (extends WinCommandContext concept
 * but specifically for filesystem operations).
 *
 * Commands: type, copy, move, ren/rename, del/erase, echo (with redirect),
 *           mkdir/md, rmdir/rd, cd/chdir, cls, tree, set,
 *           attrib, find, findstr, where, more, fc, xcopy, sort
 */

import { WindowsFileSystem } from './WindowsFileSystem';
import type {
  SocketEntry, SocketProtocol, SocketTable,
} from '../../core/SocketTable';
import {
  renderTable, type TableColumn, type TableStyle,
} from '../shells/cli/TextTable';
import type { WinCommandContext } from './WinCommandExecutor';
import { showRoutePrint } from './WinRoute';
import { netstatStatistics, type NetstatProtocolFilter } from './WinNetstatStatistics';
import { snmpSnapshot } from '../linux/ports/PortsFilesystem';
import {
  filterFind, filterFindstr, parseFindArguments, parseFindstrArguments, textLines,
} from './FindText';

/** Context provided to all Windows file command modules */
export interface WinFileCommandContext {
  fs: WindowsFileSystem;
  cwd: string;
  hostname: string;
  env: Map<string, string>;
  setEnv(name: string, value: string): void;
  setCwd(path: string): void;
  setExitCode(code: number): void;
  readonly inScript: boolean;
  readonly timezone: string;
  ask(prompt: string, preceding?: string): Promise<{ answer: string | null; flushed: boolean }>;
}

// ─── cd / chdir ────────────────────────────────────────────────────

export function cmdCd(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length === 0) {
    return ctx.cwd;
  }

  // Handle /d flag (change drive)
  let path: string;
  if (args[0].toLowerCase() === '/d' && args.length > 1) {
    path = args.slice(1).join(' ');
  } else {
    path = args.join(' ');
  }

  const absPath = ctx.fs.normalizePath(path, ctx.cwd);
  if (!ctx.fs.isDirectory(absPath)) {
    return 'The system cannot find the path specified.';
  }
  ctx.setCwd(absPath);
  return '';
}

// ─── mkdir / md ────────────────────────────────────────────────────

export function cmdMkdir(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length === 0) return 'The syntax of the command is incorrect.';
  const path = args.join(' ');
  const absPath = ctx.fs.normalizePath(path, ctx.cwd);

  // mkdir in Windows creates intermediate directories automatically
  if (ctx.fs.exists(absPath)) {
    return `A subdirectory or file ${path} already exists.`;
  }
  ctx.fs.mkdirp(absPath);
  return '';
}

// ─── rmdir / rd ────────────────────────────────────────────────────

export function cmdRmdir(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length === 0) return 'The syntax of the command is incorrect.';

  let recursive = false;
  let quiet = false;
  const pathParts: string[] = [];

  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === '/s') recursive = true;
    else if (lower === '/q') quiet = true;
    else pathParts.push(arg);
  }

  if (pathParts.length === 0) return 'The syntax of the command is incorrect.';
  const path = pathParts.join(' ');
  const absPath = ctx.fs.normalizePath(path, ctx.cwd);

  if (recursive) {
    const result = ctx.fs.rmdirRecursive(absPath);
    if (!result.ok) return result.error!;
    return '';
  }

  const result = ctx.fs.rmdir(absPath);
  if (!result.ok) return result.error!;
  return '';
}

// ─── type ──────────────────────────────────────────────────────────

export function cmdType(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length === 0) return 'The syntax of the command is incorrect.';
  const path = args.join(' ');
  const absPath = ctx.fs.normalizePath(path, ctx.cwd);
  const result = ctx.fs.readFile(absPath);
  if (!result.ok) return result.error!;
  return result.content!;
}

// ─── ren / rename ──────────────────────────────────────────────────

export function cmdRen(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length < 2) return 'The syntax of the command is incorrect.';
  const absPath = ctx.fs.normalizePath(args[0], ctx.cwd);
  const newName = args[1];
  const result = ctx.fs.renameEntry(absPath, newName);
  if (!result.ok) return result.error!;
  return '';
}

// ─── del / erase ───────────────────────────────────────────────────

export function cmdDel(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length === 0) return 'The syntax of the command is incorrect.';

  const pathParts: string[] = [];
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === '/s' || lower === '/q' || lower === '/f') continue;
    pathParts.push(arg);
  }
  if (pathParts.length === 0) return 'The syntax of the command is incorrect.';

  const pattern = pathParts.join(' ');

  // Check for wildcard
  if (pattern.includes('*') || pattern.includes('?')) {
    const count = ctx.fs.deleteGlob(ctx.cwd, pattern);
    return count > 0 ? '' : 'Could Not Find ' + pattern;
  }

  const absPath = ctx.fs.normalizePath(pattern, ctx.cwd);
  const result = ctx.fs.deleteFile(absPath);
  if (!result.ok) return result.error!;
  return '';
}

// ─── tree ──────────────────────────────────────────────────────────

export function cmdTree(ctx: WinFileCommandContext, args: string[]): string {
  let showFiles = false;
  const pathArgs: string[] = [];

  for (const arg of args) {
    if (arg.toLowerCase() === '/f') {
      showFiles = true;
    } else if (arg.toLowerCase() === '/a') {
      // ASCII mode - already default in our implementation
    } else {
      pathArgs.push(arg);
    }
  }

  const target = pathArgs.length > 0 ? pathArgs[0] : '.';
  const absPath = ctx.fs.normalizePath(target, ctx.cwd);
  return ctx.fs.tree(absPath, showFiles);
}

// ─── set ───────────────────────────────────────────────────────────

// ─── tasklist ──────────────────────────────────────────────────────

export function cmdTasklist(ctx: WinFileCommandContext): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('Image Name                     PID Session Name        Mem Usage');
  lines.push('========================= ======== ================ ===========');

  const processes = [
    ['System Idle Process',     0,  'Services',   8],
    ['System',                  4,  'Services',   144],
    ['smss.exe',               340, 'Services',   1024],
    ['csrss.exe',              472, 'Services',   4608],
    ['wininit.exe',            548, 'Services',   3584],
    ['services.exe',           620, 'Services',   7168],
    ['lsass.exe',              636, 'Services',   10240],
    ['svchost.exe',            784, 'Services',   12288],
    ['svchost.exe',            836, 'Services',   8192],
    ['dwm.exe',               1024, 'Console',    45056],
    ['explorer.exe',          2848, 'Console',    65536],
    ['cmd.exe',               5120, 'Console',    3072],
    ['conhost.exe',           5132, 'Console',    10240],
    ['tasklist.exe',          6200, 'Console',    5120],
  ];

  for (const [name, pid, session, mem] of processes) {
    const nameStr = String(name).padEnd(25);
    const pidStr = String(pid).padStart(8);
    const sessStr = String(session).padEnd(16);
    const memStr = (Number(mem) / 1024).toFixed(0) + ' K';
    lines.push(`${nameStr} ${pidStr} ${sessStr} ${memStr.padStart(11)}`);
  }

  return lines.join('\n');
}

// ─── netstat ───────────────────────────────────────────────────────

function statistiquesInterfaces(netCtx: WinCommandContext): string {
  let octetsRecus = 0, octetsEnvoyes = 0, paquetsRecus = 0, paquetsEnvoyes = 0;
  for (const [, port] of netCtx.ports) {
    const c = port.getCounters?.();
    octetsRecus += c?.bytesIn ?? 0;
    octetsEnvoyes += c?.bytesOut ?? 0;
    paquetsRecus += c?.framesIn ?? 0;
    paquetsEnvoyes += c?.framesOut ?? 0;
  }
  const ligne = (nom: string, recu: number, envoye: number) =>
    `${nom.padEnd(24)}${String(recu).padStart(12)}${String(envoye).padStart(16)}`;
  return [
    '',
    'Interface Statistics',
    '',
    `${''.padEnd(24)}${'Received'.padStart(12)}${'Sent'.padStart(16)}`,
    '',
    ligne('Bytes', octetsRecus, octetsEnvoyes),
    ligne('Unicast packets', paquetsRecus, paquetsEnvoyes),
    ligne('Non-unicast packets', 0, 0),
    ligne('Discards', 0, 0),
    ligne('Errors', 0, 0),
    ligne('Unknown protocols', 0, 0),
    '',
  ].join('\n');
}

const WINDOWS_NETSTAT_TABLE: TableStyle = { gap: 0, rule: false, indent: '  ' };

const NETSTAT_PROTOCOLS: Readonly<Record<string, SocketProtocol>> = {
  tcp: 'tcp', udp: 'udp', tcpv6: 'tcp', udpv6: 'udp',
};

const NETSTAT_FAMILIES: Record<string, NetstatProtocolFilter> = {
  ip: 'ip', ipv4: 'ipv4', icmp: 'icmp', icmpv4: 'icmpv4',
  tcp: 'tcp', tcpv4: 'tcpv4', udp: 'udp', udpv4: 'udpv4',
};

function familleDemandee(args: string[]): NetstatProtocolFilter | null {
  const at = args.findIndex((a) => a.toLowerCase() === '-p');
  if (at < 0 || args[at + 1] === undefined) return null;
  return NETSTAT_FAMILIES[args[at + 1].toLowerCase()] ?? null;
}

function protocoleDemande(args: string[]): SocketProtocol | null {
  const at = args.findIndex((a) => a.toLowerCase() === '-p');
  if (at < 0 || args[at + 1] === undefined) return null;
  return NETSTAT_PROTOCOLS[args[at + 1].toLowerCase()] ?? null;
}

export function cmdNetstat(
  ctx: WinFileCommandContext,
  args: string[] = [],
  socketTable?: SocketTable | null,
  netCtx?: WinCommandContext,
): string {
  // Expand combined flags: '-an' → chars a, n
  const hasFlag = (ch: string): boolean =>
    args.some(a => a.startsWith('-') && !a.startsWith('--') && a.includes(ch));

  if (hasFlag('r')) {
    return netCtx ? showRoutePrint(netCtx) : '';
  }

  if (hasFlag('e')) {
    return netCtx ? statistiquesInterfaces(netCtx) : '';
  }

  if (hasFlag('s')) {
    return netstatStatistics(
      snmpSnapshot(netCtx?.protocolCounters()),
      familleDemandee(args));
  }

  const showAll = hasFlag('a') || args.includes('-an');
  const withPid = hasFlag('o');
  const only = protocoleDemande(args);

  const rows = (socketTable?.getAll() ?? []).filter((sock) => {
    if (!showAll && sock.state !== 'ESTABLISHED') return false;
    return only === null || sock.protocol === only;
  });

  const columns: Array<TableColumn<SocketEntry>> = [
    { header: 'Proto', width: 7, value: (s) => s.protocol.toUpperCase() },
    {
      header: 'Local Address', width: 23,
      value: (s) => `${s.localAddress}:${s.localPort}`,
    },
    {
      header: 'Foreign Address', width: 23,
      value: (s) => (s.protocol === 'udp' ? '*:*'
        : s.state === 'LISTEN' ? '0.0.0.0:0'
          : `${s.remoteAddress}:${s.remotePort}`),
    },
    {
      header: 'State', width: 16,
      value: (s) => (s.protocol === 'udp' ? ''
        : s.state === 'LISTEN' ? 'LISTENING' : s.state),
    },
  ];
  if (withPid) columns.push({ header: 'PID', value: (s) => String(s.pid ?? 0) });

  return ['', 'Active Connections', '',
    ...renderTable(rows, columns, WINDOWS_NETSTAT_TABLE)].join('\n');
}

// ─── attrib ───────────────────────────────────────────────────────

export function cmdAttrib(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length === 0) {
    return attribList(ctx, ctx.cwd);
  }

  const setAttrs: string[] = [];
  const removeAttrs: string[] = [];
  const pathParts: string[] = [];

  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === '/s' || lower === '/d') continue;
    if (arg.match(/^\+[rahsRAHS]$/)) { setAttrs.push(arg[1].toLowerCase()); continue; }
    if (arg.match(/^-[rahsRAHS]$/)) { removeAttrs.push(arg[1].toLowerCase()); continue; }
    pathParts.push(arg);
  }

  const target = pathParts.join(' ');

  if (setAttrs.length === 0 && removeAttrs.length === 0) {
    const absPath = target ? ctx.fs.normalizePath(target, ctx.cwd) : ctx.cwd;
    if (ctx.fs.isDirectory(absPath)) return attribList(ctx, absPath);
    const entry = ctx.fs.resolve(absPath);
    if (!entry) return 'File not found - ' + target;
    return formatAttrib(entry, absPath);
  }

  if (!target) return 'The syntax of the command is incorrect.';
  const absPath = ctx.fs.normalizePath(target, ctx.cwd);
  const entry = ctx.fs.resolve(absPath);
  if (!entry) return 'File not found - ' + target;

  const attrMap: Record<string, string> = { r: 'readonly', a: 'archive', h: 'hidden', s: 'system' };
  for (const a of setAttrs) { if (attrMap[a]) entry.attributes.add(attrMap[a]); }
  for (const a of removeAttrs) { if (attrMap[a]) entry.attributes.delete(attrMap[a]); }
  return '';
}

function attribList(ctx: WinFileCommandContext, dirPath: string): string {
  const entries = ctx.fs.listDirectory(dirPath);
  const lines: string[] = [];
  for (const { name, entry } of entries) {
    const childPath = dirPath.endsWith('\\') ? dirPath + name : dirPath + '\\' + name;
    lines.push(formatAttrib(entry, childPath));
  }
  return lines.join('\n');
}

function formatAttrib(entry: { attributes: Set<string> }, path: string): string {
  const a = entry.attributes.has('archive') ? 'A' : ' ';
  const s = entry.attributes.has('system') ? 'S' : ' ';
  const h = entry.attributes.has('hidden') ? 'H' : ' ';
  const r = entry.attributes.has('readonly') ? 'R' : ' ';
  return `${a}  ${s}${h}${r}        ${path}`;
}

// ─── find ─────────────────────────────────────────────────────────

export function cmdFind(ctx: WinFileCommandContext, args: string[], stdin?: string): string {
  const parsed = parseFindArguments(args);
  if ('error' in parsed) {
    ctx.setExitCode(2);
    return parsed.error;
  }
  const { options, files } = parsed;

  if (files.length === 0) {
    if (stdin === undefined) {
      ctx.setExitCode(2);
      return 'FIND: Parameter format not correct';
    }
    const { shown, count } = filterFind(textLines(stdin), options);
    ctx.setExitCode(count > 0 ? 0 : 1);
    return options.count ? String(count) : shown.join('\n');
  }

  const lines: string[] = [];
  let matched = 0;
  let unreadable = false;
  for (const file of files) {
    const result = ctx.fs.readFile(ctx.fs.normalizePath(file, ctx.cwd));
    if (!result.ok) { lines.push(`File not found - ${file}`); unreadable = true; continue; }
    lines.push(`---------- ${file.toUpperCase()}`);
    const { shown, count } = filterFind(textLines(result.content!), options);
    matched += count;
    if (options.count) lines.push(`---------- ${file.toUpperCase()}: ${count}`);
    else lines.push(...shown);
  }
  ctx.setExitCode(unreadable ? 2 : matched > 0 ? 0 : 1);
  return lines.join('\n');
}

// ─── findstr ──────────────────────────────────────────────────────

export function cmdFindstr(ctx: WinFileCommandContext, args: string[], stdin?: string): string {
  const parsed = parseFindstrArguments(args);
  if ('error' in parsed) {
    ctx.setExitCode(2);
    return parsed.error;
  }
  const { options, files } = parsed;

  if (files.length === 0) {
    if (stdin === undefined) {
      ctx.setExitCode(2);
      return 'FINDSTR: Wrong number of arguments';
    }
    const selected = filterFindstr(textLines(stdin), options);
    if (selected === null) {
      ctx.setExitCode(2);
      return `FINDSTR: Cannot open ${options.patterns[0]}`;
    }
    ctx.setExitCode(selected.length > 0 ? 0 : 1);
    return selected.join('\n');
  }

  const lines: string[] = [];
  let unreadable = false;
  for (const file of files) {
    const result = ctx.fs.readFile(ctx.fs.normalizePath(file, ctx.cwd));
    if (!result.ok) { lines.push(`FINDSTR: Cannot open ${file}`); unreadable = true; continue; }
    const selected = filterFindstr(textLines(result.content!), options, files.length > 1 ? `${file}:` : '');
    if (selected === null) {
      ctx.setExitCode(2);
      return `FINDSTR: Cannot open ${options.patterns[0]}`;
    }
    lines.push(...selected);
  }
  const shown = lines.filter(line => !line.startsWith('FINDSTR: Cannot open ')).length;
  ctx.setExitCode(unreadable ? 2 : shown > 0 ? 0 : 1);
  return lines.join('\n');
}

// ─── more ─────────────────────────────────────────────────────────

export function cmdMore(ctx: WinFileCommandContext, args: string[], stdin?: string): string {
  if (args.length === 0) return stdin === undefined ? '' : textLines(stdin).join('\n');
  const path = args.join(' ');
  const absPath = ctx.fs.normalizePath(path, ctx.cwd);
  const result = ctx.fs.readFile(absPath);
  if (!result.ok) return `Cannot access file ${path}`;
  return result.content!;
}

// ─── fc (file compare) ───────────────────────────────────────────

export function cmdFc(ctx: WinFileCommandContext, args: string[]): string {
  if (args.length < 2) {
    ctx.setExitCode(-1);
    return 'FC: Insufficient number of file specifications';
  }

  let ignoreCase = false;
  const filePaths: string[] = [];
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === '/n' || lower === '/l' || lower === '/a') continue;
    if (lower === '/c') { ignoreCase = true; continue; }
    filePaths.push(arg);
  }

  if (filePaths.length < 2) {
    ctx.setExitCode(-1);
    return 'FC: Insufficient number of file specifications';
  }

  const absPath1 = ctx.fs.normalizePath(filePaths[0], ctx.cwd);
  const absPath2 = ctx.fs.normalizePath(filePaths[1], ctx.cwd);

  const r1 = ctx.fs.readFile(absPath1);
  if (!r1.ok) {
    ctx.setExitCode(2);
    return `FC: cannot open ${filePaths[0]} - No such file or directory`;
  }
  const r2 = ctx.fs.readFile(absPath2);
  if (!r2.ok) {
    ctx.setExitCode(2);
    return `FC: cannot open ${filePaths[1]} - No such file or directory`;
  }

  const lines1 = r1.content!.split('\n');
  const lines2 = r2.content!.split('\n');

  const lines: string[] = [];
  lines.push(`Comparing files ${filePaths[0].toUpperCase()} and ${filePaths[1].toUpperCase()}`);

  let hasDiff = false;
  const maxLen = Math.max(lines1.length, lines2.length);
  for (let i = 0; i < maxLen; i++) {
    const l1 = i < lines1.length ? lines1[i] : '';
    const l2 = i < lines2.length ? lines2[i] : '';
    const a = ignoreCase ? l1.toLowerCase() : l1;
    const b = ignoreCase ? l2.toLowerCase() : l2;
    if (a !== b) {
      hasDiff = true;
      lines.push(`***** ${filePaths[0].toUpperCase()}`);
      lines.push(l1);
      lines.push(`***** ${filePaths[1].toUpperCase()}`);
      lines.push(l2);
      lines.push('*****');
    }
  }

  if (!hasDiff) lines.push('FC: no differences encountered');
  ctx.setExitCode(hasDiff ? 1 : 0);
  return lines.join('\n');
}

// ─── xcopy ────────────────────────────────────────────────────────

// ─── sort ─────────────────────────────────────────────────────────

export function cmdSort(ctx: WinFileCommandContext, args: string[], stdin?: string): string {
  let reverse = false;
  const filePaths: string[] = [];
  for (const arg of args) {
    if (arg.toLowerCase() === '/r') { reverse = true; continue; }
    filePaths.push(arg);
  }

  let lines: string[];
  if (filePaths.length === 0) {
    if (stdin === undefined) return '';
    lines = textLines(stdin);
  } else {
    const result = ctx.fs.readFile(ctx.fs.normalizePath(filePaths[0], ctx.cwd));
    if (!result.ok) return 'The system cannot find the file specified.';
    lines = textLines(result.content!);
  }
  lines.sort((a, b) => a.localeCompare(b));
  if (reverse) lines.reverse();
  return lines.join('\n');
}
