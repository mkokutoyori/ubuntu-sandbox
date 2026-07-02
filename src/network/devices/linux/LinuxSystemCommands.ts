import type { ShellContext } from './LinuxFileCommands';
import type { MemoryProfile } from '../host/hardware';


/**
 * Simulated capacity of the `/` filesystem. df shows the real used
 * bytes from the VFS measured against this ceiling — so writing a
 * 1 GB file shifts Used / Avail / Use% live, rather than reporting
 * a frozen "25%". Keeps the other rows (/boot, /u01, tmpfs) as
 * realistic constants because they represent virtual mounts the
 * simulator doesn't track yet.
 */
const ROOT_FS_CAPACITY_KB = 52_428_800; // 50 GB

/** Walk a directory tree and return cumulative file-byte total. */
function vfsDirectorySize(ctx: ShellContext, absPath: string): number {
  const node = ctx.vfs.lstat(absPath);
  if (!node) return 0;
  if (node.type === 'file') return node.size;
  if (node.type === 'symlink') return node.size; // link target string length
  // Directory — recurse.
  const entries = ctx.vfs.listDirectory(absPath);
  if (!entries) return 0;
  let total = 0;
  for (const { name, inode } of entries) {
    if (name === '.' || name === '..') continue;
    const childPath = absPath === '/' ? `/${name}` : `${absPath}/${name}`;
    if (inode.type === 'directory') {
      total += vfsDirectorySize(ctx, childPath);
    } else {
      total += inode.size;
    }
  }
  return total;
}

/** Inode count under a directory (recursive). Used by `df -i`. */
function vfsInodeCount(ctx: ShellContext, absPath: string): number {
  const node = ctx.vfs.lstat(absPath);
  if (!node) return 0;
  if (node.type !== 'directory') return 1;
  let count = 1;
  const entries = ctx.vfs.listDirectory(absPath);
  if (!entries) return count;
  for (const { name, inode } of entries) {
    if (name === '.' || name === '..') continue;
    const childPath = absPath === '/' ? `/${name}` : `${absPath}/${name}`;
    count += inode.type === 'directory'
      ? vfsInodeCount(ctx, childPath)
      : 1;
  }
  return count;
}

/** Format a kilobyte count as df-style human-readable string. */
function formatKbHuman(kb: number): string {
  if (kb < 1024) return `${kb}K`;
  const mb = kb / 1024;
  if (mb < 1024) return mb >= 10 ? `${Math.round(mb)}M` : `${mb.toFixed(1)}M`;
  const gb = mb / 1024;
  if (gb < 1024) return gb >= 10 ? `${Math.round(gb)}G` : `${gb.toFixed(1)}G`;
  const tb = gb / 1024;
  return tb >= 10 ? `${Math.round(tb)}T` : `${tb.toFixed(1)}T`;
}

/** Format a byte count as du-style human-readable string. */
function formatBytesHuman(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return formatKbHuman(Math.max(1, Math.round(bytes / 1024)));
}

interface DfEntry { fs: string; type: string; sizeKb: number; usedKb: number; availKb: number; usePct: number; mount: string; }

function dfTable(ctx: ShellContext): DfEntry[] {
  const rootUsedBytes = vfsDirectorySize(ctx, '/');
  const rootUsedKb = Math.max(1, Math.ceil(rootUsedBytes / 1024));
  const rootAvailKb = Math.max(0, ROOT_FS_CAPACITY_KB - rootUsedKb);
  const rootUsePct = Math.min(100, Math.ceil((rootUsedKb / ROOT_FS_CAPACITY_KB) * 100));
  return [
    { fs: '/dev/sda1', type: 'ext4', sizeKb: ROOT_FS_CAPACITY_KB, usedKb: rootUsedKb, availKb: rootAvailKb, usePct: rootUsePct, mount: '/' },
    { fs: 'tmpfs', type: 'tmpfs', sizeKb: 512000, usedKb: 0, availKb: 512000, usePct: 0, mount: '/dev/shm' },
    { fs: 'tmpfs', type: 'tmpfs', sizeKb: 5120, usedKb: 4, availKb: 5116, usePct: 1, mount: '/run/lock' },
    { fs: '/dev/sda2', type: 'ext4', sizeKb: 999424, usedKb: 148480, availKb: 782080, usePct: 16, mount: '/boot' },
    { fs: '/dev/sdb1', type: 'ext4', sizeKb: 104857600, usedKb: 29360128, availKb: 71303168, usePct: 29, mount: '/u01' },
  ];
}

function dfTableAll(ctx: ShellContext): DfEntry[] {
  return [
    ...dfTable(ctx),
    { fs: 'proc', type: 'proc', sizeKb: 0, usedKb: 0, availKb: 0, usePct: 0, mount: '/proc' },
    { fs: 'sysfs', type: 'sysfs', sizeKb: 0, usedKb: 0, availKb: 0, usePct: 0, mount: '/sys' },
    { fs: 'devpts', type: 'devpts', sizeKb: 0, usedKb: 0, availKb: 0, usePct: 0, mount: '/dev/pts' },
    { fs: 'cgroup', type: 'cgroup2', sizeKb: 0, usedKb: 0, availKb: 0, usePct: 0, mount: '/sys/fs/cgroup' },
  ];
}

export function cmdDf(ctx: ShellContext, args: string[]): string {
  const human = args.includes('-h') || args.includes('--human-readable');
  const inodes = args.includes('-i');
  let showType = args.includes('-T') || args.includes('--print-type');
  const all = args.includes('-a') || args.includes('--all');

  const includeTypes: string[] = [];
  const excludeTypes: string[] = [];
  const targets: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-t' || a === '--type') { includeTypes.push(args[++i] ?? ''); continue; }
    if (a === '-x' || a === '--exclude-type') { excludeTypes.push(args[++i] ?? ''); continue; }
    if (a.startsWith('-')) {
      if (!['-h', '--human-readable', '-i', '-T', '--print-type', '-a', '--all', '-H', '-k', '-m', '-l', '--local', '-P', '--portability', '-B', '--block-size'].includes(a)) {
        if (/^-h+$/.test(a) && a.length > 2) return `df: invalid option -- '${a.slice(1)}'`;
        return `df: invalid option -- '${a.replace(/^-+/, '')}'`;
      }
      continue;
    }
    targets.push(a);
  }

  for (const t of targets) {
    if (!ctx.vfs.exists(ctx.vfs.normalizePath(t, ctx.cwd))) {
      return `df: ${t}: No such file or directory`;
    }
  }

  if (includeTypes.length > 0) showType = true;
  let rows = all ? dfTableAll(ctx) : dfTable(ctx);
  if (includeTypes.length > 0) {
    rows = rows.filter(r => includeTypes.includes(r.type));
    if (rows.length === 0) return `df: no file systems processed`;
  }
  if (excludeTypes.length > 0) rows = rows.filter(r => !excludeTypes.includes(r.type));
  if (!all) rows = rows.filter(r => !(r.fs === 'tmpfs' && r.usedKb === 0));
  if (targets.length > 0) {
    const annotated = targets.map(t => {
      const tp = ctx.vfs.normalizePath(t, ctx.cwd);
      let best: DfEntry | undefined;
      for (const r of rows) {
        if (tp === r.mount || tp.startsWith(r.mount === '/' ? '/' : r.mount + '/')) {
          if (!best || r.mount.length > best.mount.length) best = r;
        }
      }
      return best ? { ...best, mount: tp } : null;
    }).filter((r): r is DfEntry => r !== null);
    rows = annotated;
  }

  const rootUsedBytes = vfsDirectorySize(ctx, '/');
  const rootUsedKb = Math.max(1, Math.ceil(rootUsedBytes / 1024));
  const rootAvailKb = Math.max(0, ROOT_FS_CAPACITY_KB - rootUsedKb);
  const rootUsePct = Math.min(100, Math.ceil((rootUsedKb / ROOT_FS_CAPACITY_KB) * 100));

  if (showType) {
    const header = human
      ? 'Filesystem     Type     Size  Used Avail Use% Mounted on'
      : 'Filesystem     Type    1K-blocks     Used Available Use% Mounted on';
    const lines = rows.map(r => {
      if (human) return `${r.fs.padEnd(15)} ${r.type.padEnd(8)} ${formatKbHuman(r.sizeKb).padStart(4)} ${formatKbHuman(r.usedKb).padStart(5)} ${formatKbHuman(r.availKb).padStart(5)} ${String(r.usePct).padStart(3)}% ${r.mount}`;
      return `${r.fs.padEnd(15)} ${r.type.padEnd(7)} ${String(r.sizeKb).padStart(9)} ${String(r.usedKb).padStart(8)} ${String(r.availKb).padStart(9)} ${String(r.usePct).padStart(3)}% ${r.mount}`;
    });
    return [header, ...lines].join('\n');
  }

  if (inodes) {
    const rootInodes = vfsInodeCount(ctx, '/');
    const rootInodeCap = 655_360;
    const rootInodeFree = Math.max(0, rootInodeCap - rootInodes);
    const rootInodePct = Math.min(100, Math.ceil((rootInodes / rootInodeCap) * 100));
    return [
      'Filesystem      Inodes  IUsed   IFree IUse% Mounted on',
      `/dev/sda1       ${String(rootInodeCap).padStart(6)}  ${String(rootInodes).padStart(5)}  ${String(rootInodeFree).padStart(6)}  ${String(rootInodePct).padStart(3)}% /`,
      'tmpfs           127960      1  127959    1% /dev/shm',
      '/dev/sda2       131072   2145  128927    2% /boot',
    ].join('\n');
  }

  const header = human
    ? 'Filesystem      Size  Used Avail Use% Mounted on'
    : 'Filesystem     1K-blocks     Used Available Use% Mounted on';
  const lines = rows.map(r => {
    if (human) return `${r.fs.padEnd(15)} ${formatKbHuman(r.sizeKb).padStart(4)} ${formatKbHuman(r.usedKb).padStart(5)} ${formatKbHuman(r.availKb).padStart(5)} ${String(r.usePct).padStart(3)}% ${r.mount}`;
    return `${r.fs.padEnd(15)} ${String(r.sizeKb).padStart(9)} ${String(r.usedKb).padStart(8)} ${String(r.availKb).padStart(9)} ${String(r.usePct).padStart(3)}% ${r.mount}`;
  });
  return [header, ...lines].join('\n');
}

export function cmdDu(ctx: ShellContext, args: string[]): string {
  // Real GNU du accepts combined short options (`-sh`, `-sb`, `-bsh`).
  // Split them so the flag tests below work uniformly.
  const expand = (a: string): string[] => {
    if (!a.startsWith('-') || a.startsWith('--') || a.length <= 2) return [a];
    return a.slice(1).split('').map((c) => `-${c}`);
  };
  const expanded = args.flatMap(expand);
  const human = expanded.includes('-h') || expanded.includes('--human-readable');
  const summary = expanded.includes('-s') || expanded.includes('--summarize');
  const bytesFlag = expanded.includes('-b') || expanded.includes('--bytes');
  const targets = expanded.filter(a => !a.startsWith('-'));
  const target = targets[targets.length - 1] ?? '.';
  const absPath = ctx.vfs.normalizePath(target, ctx.cwd);

  if (!ctx.vfs.exists(absPath)) {
    return `du: cannot access '${target}': No such file or directory`;
  }

  const fmt = (bytes: number): string => {
    if (bytesFlag) return String(bytes);
    if (human) return formatBytesHuman(bytes);
    // Default: 1024-byte blocks (GNU `du --block-size=1k`).
    return String(Math.max(1, Math.ceil(bytes / 1024)));
  };

  const node = ctx.vfs.lstat(absPath);
  if (!node) return `du: cannot access '${target}': No such file or directory`;

  // File leaf — single line of its size.
  if (node.type !== 'directory') {
    return `${fmt(node.size)}\t${target}`;
  }

  // Summary — total bytes under the directory, one line.
  if (summary) {
    return `${fmt(vfsDirectorySize(ctx, absPath))}\t${target}`;
  }

  // Full mode — emit one line per descendant directory (real du does
  // post-order, deepest first), terminated by the total for `target`.
  const lines: string[] = [];
  const visit = (path: string, display: string): number => {
    const stat = ctx.vfs.lstat(path);
    if (!stat) return 0;
    if (stat.type !== 'directory') return stat.size;
    let subtotal = 0;
    const entries = ctx.vfs.listDirectory(path);
    if (entries) {
      for (const { name, inode } of entries) {
        if (name === '.' || name === '..') continue;
        const childPath = path === '/' ? `/${name}` : `${path}/${name}`;
        const childDisplay = display === '.' ? `./${name}` : `${display}/${name}`;
        if (inode.type === 'directory') {
          subtotal += visit(childPath, childDisplay);
        } else {
          subtotal += inode.size;
        }
      }
    }
    lines.push(`${fmt(subtotal)}\t${display}`);
    return subtotal;
  };
  visit(absPath, target);
  return lines.join('\n');
}

/**
 * `free` — report memory usage. Rendered from the host's {@link MemoryProfile}
 * so it stays coherent with `/proc/meminfo` and the hardware inventory.
 */
export function cmdFree(args: string[], memory: MemoryProfile): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '--count') {
      const v = args[++i];
      if (!v || !/^\d+$/.test(v) || parseInt(v, 10) < 1) {
        return `free: invalid count value '${v ?? ''}'`;
      }
      continue;
    }
    if (a === '-s' || a === '--seconds') {
      const v = args[++i];
      if (!v || !/^\d+(?:\.\d+)?$/.test(v)) {
        return `free: invalid seconds value '${v ?? ''}'`;
      }
      continue;
    }
  }
  const human = args.includes('-h') || args.includes('--human-readable');
  const wide = args.includes('-w') || args.includes('--wide');
  const total = args.includes('-t') || args.includes('--total');
  let unit: 'b' | 'k' | 'm' | 'g' = 'k';
  if (args.includes('-b') || args.includes('--bytes')) unit = 'b';
  else if (args.includes('-m') || args.includes('--mega') || args.includes('--mebi')) unit = 'm';
  else if (args.includes('-g') || args.includes('--giga') || args.includes('--gibi')) unit = 'g';
  return memory.toFree(human, wide, unit, total);
}

export function cmdLsblk(args: string[]): string {
  const all = args.includes('-a') || args.includes('--all');
  const fs = args.includes('-f') || args.includes('--fs');

  if (fs) {
    return [
      'NAME   FSTYPE FSVER LABEL UUID                                 FSAVAIL FSUSE% MOUNTPOINTS',
      'sda                                                                           ',
      '├─sda1 ext4   1.0         a1b2c3d4-e5f6-7890-abcd-ef1234567890   36G    25% /',
      '└─sda2 ext4   1.0         11223344-5566-7788-99aa-bbccddeeff00  764M    16% /boot',
      'sdb                                                                           ',
      '└─sdb1 ext4   1.0         aabbccdd-eeff-0011-2233-445566778899   68G    29% /u01',
    ].join('\n');
  }

  const lines = [
    'NAME   MAJ:MIN RM   SIZE RO TYPE MOUNTPOINTS',
    'sda      8:0    0    52G  0 disk ',
    '├─sda1   8:1    0    50G  0 part /',
    '└─sda2   8:2    0     1G  0 part /boot',
    'sdb      8:16   0   100G  0 disk ',
    '└─sdb1   8:17   0   100G  0 part /u01',
  ];

  if (all) {
    lines.push('sr0     11:0    1  1024M  0 rom  ');
  }

  return lines.join('\n');
}

// ─── top (one-shot snapshot) ────────────────────────────────────────

export function cmdTop(
  args: string[],
  currentUser: string,
  systemProcesses: Map<number, { user: string; command: string }>,
): string {
  const batchMode = args.includes('-b');
  const nArg = args.indexOf('-n');
  // We always return one snapshot (non-interactive simulator)

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour12: false });
  const procs = [
    { pid: 1, user: 'root', pr: 20, ni: 0, virt: '169M', res: '13M', shr: '8M', s: 'S', cpu: 0.0, mem: 0.3, time: '0:01.24', cmd: 'systemd' },
  ];

  // Add registered system processes (Oracle, etc.)
  for (const [pid, proc] of systemProcesses) {
    procs.push({
      pid, user: proc.user, pr: 20, ni: 0,
      virt: `${Math.floor(Math.random() * 500) + 100}M`,
      res: `${Math.floor(Math.random() * 200) + 20}M`,
      shr: `${Math.floor(Math.random() * 30) + 5}M`,
      s: 'S', cpu: Math.random() * 2, mem: Math.random() * 5,
      time: '0:00.50', cmd: proc.command.split('/').pop()!.split(' ')[0],
    });
  }

  // Current shell
  procs.push({ pid: 9999, user: currentUser, pr: 20, ni: 0, virt: '10M', res: '4M', shr: '3M', s: 'S', cpu: 0.0, mem: 0.1, time: '0:00.02', cmd: 'bash' });

  const totalMem = 3981;
  const usedMem = 1258;
  const freeMem = 1468;
  const bufCache = 1254;

  const header = [
    `top - ${timeStr} up  0:05,  1 user,  load average: 0.08, 0.03, 0.01`,
    `Tasks: ${procs.length} total,   0 running, ${procs.length} sleeping,   0 stopped,   0 zombie`,
    `%Cpu(s):  1.2 us,  0.5 sy,  0.0 ni, 98.2 id,  0.1 wa,  0.0 hi,  0.0 si,  0.0 st`,
    `MiB Mem :  ${totalMem}.0 total,  ${freeMem}.0 free,  ${usedMem}.0 used,  ${bufCache}.0 buff/cache`,
    `MiB Swap:  2048.0 total,  2048.0 free,      0.0 used.  2519.0 avail Mem`,
    '',
    '    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND',
  ];

  for (const p of procs) {
    header.push(
      `${String(p.pid).padStart(7)} ${p.user.padEnd(9)} ${String(p.pr).padStart(3)} ${String(p.ni).padStart(4)} ${p.virt.padStart(7)} ${p.res.padStart(6)} ${p.shr.padStart(6)} ${p.s}  ${p.cpu.toFixed(1).padStart(4)}  ${p.mem.toFixed(1).padStart(4)} ${p.time.padStart(9)} ${p.cmd}`
    );
  }

  return header.join('\n');
}
