/**
 * `sysctl` — read and write kernel parameters.
 *
 * `/proc/sys` is the STORE and this command is only its reader, in that
 * order — `sysctl net.ipv4.conf.all.arp_ignore` and
 * `cat /proc/sys/net/ipv4/conf/all/arp_ignore` cannot answer differently
 * about the same machine, exactly as `lsmod` reads `/proc/modules`.
 *
 * Messages and exit codes are procps-ng's own (`src/sysctl.c`): a key
 * that does not exist fails with `cannot stat <path>` in both
 * directions, and a key whose projection is read-only refuses the write
 * with the EPERM branch rather than accepting it and doing nothing.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

const PROC_SYS = '/proc/sys';
const DEFAULT_PRELOAD = '/etc/sysctl.conf';
const SYSTEM_DIRS = [
  '/etc/sysctl.d', '/run/sysctl.d', '/usr/local/lib/sysctl.d',
  '/usr/lib/sysctl.d', '/lib/sysctl.d',
];

interface SysctlResult { output: string; exitCode: number; stderr?: string }

interface SysctlOptions {
  all: boolean;
  write: boolean;
  valuesOnly: boolean;
  namesOnly: boolean;
  quiet: boolean;
  ignoreErrors: boolean;
  pattern: string | null;
  load: string | null;
  system: boolean;
  params: string[];
}

function pathForKey(key: string): string {
  return `${PROC_SYS}/${key.replace(/\./g, '/')}`;
}

function keyForPath(path: string): string {
  return path.slice(PROC_SYS.length + 1).replace(/\//g, '.');
}

function parseArgs(args: string[]): SysctlOptions {
  const opts: SysctlOptions = {
    all: false, write: false, valuesOnly: false, namesOnly: false,
    quiet: false, ignoreErrors: false, pattern: null,
    load: null, system: false, params: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-r' || arg === '--pattern') { opts.pattern = args[++i] ?? null; continue; }
    if (arg === '--system') { opts.system = true; continue; }
    if (arg === '--load' || arg === '-p' || arg === '-f') {
      const next = args[i + 1];
      opts.load = next !== undefined && !next.startsWith('-') ? args[++i] : DEFAULT_PRELOAD;
      continue;
    }
    if (arg.startsWith('--load=')) { opts.load = arg.slice('--load='.length); continue; }
    if (arg === '--all' || arg === '--values' || arg === '--names'
      || arg === '--quiet' || arg === '--ignore' || arg === '--write') {
      const long = arg.slice(2);
      if (long === 'all') opts.all = true;
      if (long === 'values') opts.valuesOnly = true;
      if (long === 'names') opts.namesOnly = true;
      if (long === 'quiet') opts.quiet = true;
      if (long === 'ignore') opts.ignoreErrors = true;
      if (long === 'write') opts.write = true;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1 && !arg.startsWith('--')) {
      for (const flag of arg.slice(1)) {
        if (flag === 'a' || flag === 'A' || flag === 'X') opts.all = true;
        else if (flag === 'w') opts.write = true;
        else if (flag === 'n') opts.valuesOnly = true;
        else if (flag === 'N') opts.namesOnly = true;
        else if (flag === 'q') opts.quiet = true;
        else if (flag === 'e') opts.ignoreErrors = true;
        else if (flag === 'p' || flag === 'f') opts.load = DEFAULT_PRELOAD;
      }
      continue;
    }
    if (arg.startsWith('--')) continue;
    opts.params.push(arg);
  }
  return opts;
}

function readValue(ctx: LinuxCommandContext, path: string): string | null {
  const raw = ctx.executor.vfs.readFile(path);
  if (raw === null || raw === undefined) return null;
  return raw.replace(/\n+$/, '');
}

function renderLeaf(opts: SysctlOptions, key: string, value: string): string | null {
  if (opts.pattern && !new RegExp(opts.pattern).test(key)) return null;
  if (opts.namesOnly) return key;
  if (opts.valuesOnly) return value;
  return `${key} = ${value}`;
}

function collectLeaves(ctx: LinuxCommandContext, dir: string): string[] {
  const vfs = ctx.executor.vfs;
  const out: string[] = [];
  const walk = (path: string): void => {
    const entries = (vfs.listDirectory(path) ?? [])
      .filter(e => e.name !== '.' && e.name !== '..')
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      if (entry.inode.type === 'directory') walk(child);
      else out.push(child);
    }
  };
  walk(dir);
  return out;
}

function displayTree(ctx: LinuxCommandContext, opts: SysctlOptions, dir: string): SysctlResult {
  const lines: string[] = [];
  for (const path of collectLeaves(ctx, dir)) {
    const value = readValue(ctx, path);
    if (value === null) continue;
    const line = renderLeaf(opts, keyForPath(path), value);
    if (line !== null) lines.push(line);
  }
  return { output: lines.join('\n'), exitCode: 0 };
}

function cannotStat(path: string): SysctlResult {
  return { output: '', exitCode: 1, stderr: `sysctl: cannot stat ${path}: No such file or directory` };
}

function readKey(ctx: LinuxCommandContext, opts: SysctlOptions, key: string): SysctlResult {
  const path = pathForKey(key);
  const vfs = ctx.executor.vfs;
  if (vfs.listDirectory(path)) return displayTree(ctx, opts, path);
  const value = readValue(ctx, path);
  if (value === null) {
    if (opts.ignoreErrors) return { output: '', exitCode: 0 };
    return cannotStat(path);
  }
  const line = renderLeaf(opts, key, value);
  return { output: line ?? '', exitCode: 0 };
}

function writeKey(ctx: LinuxCommandContext, opts: SysctlOptions, key: string, value: string): SysctlResult {
  const path = pathForKey(key);
  const vfs = ctx.executor.vfs;
  if (!vfs.exists(path)) {
    if (opts.ignoreErrors) return { output: '', exitCode: 0 };
    return cannotStat(path);
  }
  if (vfs.listDirectory(path)) {
    return { output: '', exitCode: 1, stderr: `sysctl: setting key "${key}": Is a directory` };
  }

  const writer = sysctlWriter(key);
  if (writer) {
    writer(ctx, value);
  } else if (!vfs.writeFile(path, `${value}\n`, 0, 0, 0o022) || readValue(ctx, path) !== value) {
    return { output: '', exitCode: 1, stderr: `sysctl: setting key "${key}": Operation not permitted` };
  }

  if (opts.quiet) return { output: '', exitCode: 0 };
  const shown = readValue(ctx, path) ?? value;
  return { output: renderLeaf(opts, key, shown) ?? '', exitCode: 0 };
}

type SysctlWriter = (ctx: LinuxCommandContext, value: string) => void;

function sysctlWriter(key: string): SysctlWriter | null {
  if (key === 'net.ipv4.ip_forward') {
    return (ctx, value) => ctx.net.setIpForward(value === '1');
  }
  if (key === 'net.ipv4.icmp_echo_ignore_broadcasts') {
    return (ctx, value) => {
      const host = (ctx.executor as unknown as {
        localDevice?: { setIgnoresBroadcastEcho?(on: boolean): void };
      }).localDevice;
      host?.setIgnoresBroadcastEcho?.(value === '1');
    };
  }
  if (key === 'net.ipv4.tcp_tw_reuse') {
    return (ctx, value) => {
      const st = (ctx.executor as unknown as { socketTable?: { setTcpTwReuse(v: boolean): void } }).socketTable;
      st?.setTcpTwReuse(value === '1');
    };
  }
  if (key === 'net.ipv4.ip_local_port_range') {
    return (ctx, value) => {
      const exec = ctx.executor as unknown as { applyEphemeralRange(min: number, max: number): void };
      const parts = value.replace(/["']/g, '').split(/\s+/).filter(Boolean);
      const min = Number(parts[0]);
      const max = Number(parts[1] ?? parts[0]);
      if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max <= 65535 && min <= max) {
        exec.applyEphemeralRange(min, max);
      }
    };
  }
  return null;
}

function preload(ctx: LinuxCommandContext, opts: SysctlOptions, file: string): SysctlResult {
  const text = ctx.executor.vfs.readFile(file);
  if (text === null || text === undefined) {
    return { output: '', exitCode: 1, stderr: `sysctl: cannot open "${file}": No such file or directory` };
  }

  const outputs: string[] = [];
  const errors: string[] = [];
  let failed = false;
  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n++) {
    let key = lines[n].replace(/^\s+/, '');
    if (key.length < 2 || key.startsWith('#') || key.startsWith(';')) continue;
    const eq = key.indexOf('=');
    if (eq === -1) {
      if (key.startsWith('-')) continue;
      errors.push(`sysctl: ${file}(${n + 1}): invalid syntax, continuing...`);
      continue;
    }
    let ignore = opts.ignoreErrors;
    const value = key.slice(eq + 1).trim();
    key = key.slice(0, eq).trim();
    if (key.startsWith('-')) { ignore = true; key = key.slice(1); }
    if (opts.pattern && !new RegExp(opts.pattern).test(key)) continue;
    const r = writeKey(ctx, { ...opts, ignoreErrors: ignore }, key, value);
    if (r.output) outputs.push(r.output);
    if (r.stderr) errors.push(r.stderr);
    if (r.exitCode !== 0) failed = true;
  }
  return {
    output: outputs.join('\n'),
    exitCode: failed ? 1 : 0,
    stderr: errors.join('\n') || undefined,
  };
}

function preloadSystem(ctx: LinuxCommandContext, opts: SysctlOptions): SysctlResult {
  const vfs = ctx.executor.vfs;
  const seen = new Map<string, string>();
  for (const dir of SYSTEM_DIRS) {
    for (const entry of vfs.listDirectory(dir) ?? []) {
      if (!entry.name.endsWith('.conf') || entry.name.length < 5) continue;
      if (!seen.has(entry.name)) seen.set(entry.name, `${dir}/${entry.name}`);
    }
  }
  const files = [...seen.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, path]) => path);
  if (vfs.exists(DEFAULT_PRELOAD)) files.push(DEFAULT_PRELOAD);

  const outputs: string[] = [];
  const errors: string[] = [];
  let failed = false;
  for (const file of files) {
    if (!opts.quiet) outputs.push(`* Applying ${file} ...`);
    const r = preload(ctx, opts, file);
    if (r.output) outputs.push(r.output);
    if (r.stderr) errors.push(r.stderr);
    if (r.exitCode !== 0) failed = true;
  }
  return {
    output: outputs.join('\n'),
    exitCode: failed ? 1 : 0,
    stderr: errors.join('\n') || undefined,
  };
}

function execute(ctx: LinuxCommandContext, args: string[]): SysctlResult {
  const opts = parseArgs(args);
  if (opts.system) return preloadSystem(ctx, opts);
  if (opts.load !== null) return preload(ctx, opts, opts.load);
  if (opts.all) return displayTree(ctx, opts, PROC_SYS);

  const results: SysctlResult[] = [];
  for (let i = 0; i < opts.params.length; i++) {
    const param = opts.params[i];
    const eq = param.indexOf('=');
    if (eq === -1) {
      if (opts.write) continue;
      results.push(readKey(ctx, opts, param));
      continue;
    }
    const key = param.slice(0, eq);
    let value = param.slice(eq + 1).replace(/^["']|["']$/g, '');
    if (key === 'net.ipv4.ip_local_port_range' && !/\s/.test(value) && /^\d+$/.test(opts.params[i + 1] ?? '')) {
      value = `${value} ${opts.params[++i]}`;
    }
    results.push(writeKey(ctx, opts, key, value));
  }

  return {
    output: results.map(r => r.output).filter(Boolean).join('\n'),
    exitCode: results.some(r => r.exitCode !== 0) ? 1 : 0,
    stderr: results.map(r => r.stderr).filter(Boolean).join('\n') || undefined,
  };
}

export const sysctlCommand: LinuxCommand = {
  name: 'sysctl',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'sysctl [options] [variable[=value] ...]',
  help:
    'Configure kernel parameters at runtime.\n\n' +
    'OPTIONS\n' +
    '  -a, --all       display all variables\n' +
    '  -e, --ignore    ignore unknown variables errors\n' +
    '  -N, --names     print variable names without values\n' +
    '  -n, --values    print only values of the given variable(s)\n' +
    '  -p, --load[=<file>]  read values from file\n' +
    '      --system    read values from all system directories\n' +
    '  -q, --quiet     do not echo variable set\n' +
    '  -r, --pattern <expression>\n' +
    '                  select setting that match expression\n' +
    '  -w, --write     enable writing a value to variable\n\n' +
    'Every variable under /proc/sys is readable; writing one needs a\n' +
    'parameter this build backs with real state.',

  complete(ctx: LinuxCommandContext, args: string[]): string[] {
    const partial = args[args.length - 1] ?? '';
    if (partial.startsWith('-')) {
      return ['-a', '-e', '-N', '-n', '-p', '-q', '-r', '-w', '--system']
        .filter(f => f.startsWith(partial));
    }
    return collectLeaves(ctx, PROC_SYS)
      .map(keyForPath)
      .filter(k => k.startsWith(partial));
  },

  run(ctx: LinuxCommandContext, args: string[]): string {
    const r = execute(ctx, args);
    return r.stderr ? [r.output, r.stderr].filter(Boolean).join('\n') : r.output;
  },

  runWithStatusSync(ctx: LinuxCommandContext, args: string[]): SysctlResult {
    return execute(ctx, args);
  },
};
