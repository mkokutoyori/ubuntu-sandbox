import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';
import { RADVD_CONFIG_PATH, RADVD_PID_PATH, RADVD_VERSION } from '../../radvd/LinuxRadvdService';

const BINARY = '/usr/sbin/radvd';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const VERSION_TEXT = [
  `Version: ${RADVD_VERSION}`,
  '',
  'Compiled in settings:',
  `  default config file\t\t"${RADVD_CONFIG_PATH}"`,
  `  default pidfile\t\t"${RADVD_PID_PATH}"`,
  '  default logfile\t\t"/var/log/radvd.log"',
  '  default syslog facility\t24',
  'Please send bug reports or suggestions to Reuben Hawkins <reubenhwk@gmail.com>.',
].join('\n');

const USAGE = [
  'usage: radvd ',
  '  -C, --config=PATH       Set the config file.  Default is /etc/radvd.d.',
  '  -c, --configtest        Parse the config file and exit.',
  '  -d, --debug=NUM         Set the debug level.  Values can be 1, 2, 3, 4 or 5.',
  '  -f, --facility=NUM      Set the logging facility.',
  '  -h, --help              Show this help screen.',
  '  -l, --logfile=PATH      Set the log file.',
  '  -m, --logmethod=X       Set method to: syslog, stderr, stderr_syslog, logfile,',
  '                          stderr_clean, or none.',
  '  -n, --nodaemon          Prevent the daemonizing.',
  '  -p, --pidfile=PATH      Set the pid file.',
  '  -t, --chrootdir=PATH    Chroot to the specified path.',
  '  -u, --username=USER     Switch to the specified user.',
  '  -v, --version           Print the version and quit.',
  '',
].join('\n');

const LONG_OPTIONS: Readonly<Record<string, { short: string; takesArgument: boolean }>> = {
  config: { short: 'C', takesArgument: true }, configtest: { short: 'c', takesArgument: false },
  debug: { short: 'd', takesArgument: true }, facility: { short: 'f', takesArgument: true },
  help: { short: 'h', takesArgument: false }, logfile: { short: 'l', takesArgument: true },
  logmethod: { short: 'm', takesArgument: true }, nodaemon: { short: 'n', takesArgument: false },
  pidfile: { short: 'p', takesArgument: true }, chrootdir: { short: 't', takesArgument: true },
  username: { short: 'u', takesArgument: true }, version: { short: 'v', takesArgument: false },
};
const SHORT_WITH_ARGUMENT = new Set(['C', 'd', 'f', 'l', 'm', 'p', 't', 'u']);
const SHORT_FLAGS = new Set(['c', 'h', 'n', 'v']);

interface Parsed {
  config: string;
  configTest: boolean;
  clean: boolean;
  usage: boolean;
  version: boolean;
  error?: string;
}

function parse(args: readonly string[]): Parsed {
  const parsed: Parsed = { config: RADVD_CONFIG_PATH, configTest: false, clean: false, usage: false, version: false };
  const apply = (letter: string, value: string | undefined): void => {
    if (letter === 'C') parsed.config = value ?? RADVD_CONFIG_PATH;
    else if (letter === 'c') parsed.configTest = true;
    else if (letter === 'h') parsed.usage = true;
    else if (letter === 'v') parsed.version = true;
    else if (letter === 'm') parsed.clean = value === 'stderr_clean';
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2);
      const option = LONG_OPTIONS[name];
      if (option === undefined) return { ...parsed, error: `radvd: unrecognized option '${arg}'` };
      let value = inline;
      if (option.takesArgument && value === undefined) value = args[++i];
      if (option.takesArgument && value === undefined) return { ...parsed, error: `radvd: option '--${name}' requires an argument` };
      apply(option.short, value);
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let at = 1; at < arg.length; at++) {
        const letter = arg[at];
        if (SHORT_FLAGS.has(letter)) { apply(letter, undefined); continue; }
        if (!SHORT_WITH_ARGUMENT.has(letter)) return { ...parsed, error: `radvd: invalid option -- '${letter}'` };
        const rest = arg.slice(at + 1);
        const value = rest !== '' ? rest : args[++i];
        if (value === undefined) return { ...parsed, error: `radvd: option requires an argument -- '${letter}'` };
        apply(letter, value);
        break;
      }
    }
  }
  return parsed;
}

function stamp(date: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${MONTHS[date.getUTCMonth()]} ${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`;
}

function run(ctx: LinuxCommandContext, args: string[]): { output: string; exitCode: number } {
  const parsed = parse(args);
  if (parsed.error !== undefined) return { output: parsed.error, exitCode: 1 };
  if (parsed.usage) return { output: USAGE, exitCode: 1 };
  if (parsed.version) return { output: VERSION_TEXT, exitCode: 1 };
  const service = ctx.executor.radvdService;
  if (service === null) return { output: `radvd: ${BINARY}: not available on this machine`, exitCode: 1 };
  const pid = 4000 + (Math.floor(ctx.executor.simulatedDate().getTime() / 1000) % 1000);
  const line = (message: string): string => (parsed.clean ? message : `[${stamp(ctx.executor.simulatedDate())}] radvd (${pid}): ${message}`);
  const lines: string[] = [];

  const mode = ctx.executor.vfs.lstat(parsed.config)?.permissions;
  if (mode === undefined) {
    lines.push(line(`can't open ${parsed.config}: No such file or directory`));
    lines.push(line('Insecure file permissions, but continuing anyway'));
  } else if ((mode & 0o002) !== 0) {
    lines.push(line(`Insecure file permissions (writable by others): ${parsed.config}`));
    lines.push(line('Insecure file permissions, but continuing anyway'));
  }

  const checked = service.checkConfig(parsed.config);
  if (!checked.missing) {
    for (const entry of checked.log) lines.push(line(entry.message));
  }
  lines.push(...checked.stderr);
  if (checked.interfaces === null) {
    lines.push(line('exiting, failed to read config file'));
    return { output: lines.join('\n'), exitCode: 1 };
  }
  if (parsed.configTest) {
    lines.push(line(`config file, ${parsed.config}, syntax ok`));
    return { output: lines.join('\n'), exitCode: 0 };
  }
  if (service.isRunning()) {
    lines.push(line(`unable to lock pid file, ${RADVD_PID_PATH}: Resource temporarily unavailable`));
    return { output: lines.join('\n'), exitCode: 1 };
  }
  service.setConfigPath(parsed.config);
  const started = ctx.executor.serviceMgr.start('radvd');
  if (!started.ok) lines.push(started.error ?? 'radvd: failed to start');
  return { output: lines.join('\n'), exitCode: started.ok ? 0 : 1 };
}

export const radvdCommand: LinuxCommand = {
  name: 'radvd',
  package: 'radvd',
  needsNetworkContext: true,
  binaryPath: BINARY,
  manSection: 8,
  usage: 'radvd [-C config] [-c] [-d level] [-m method] [-n] [-p pidfile] [-u user] [-v]',
  help: 'Router Advertisement Daemon: sends ICMPv6 Router Advertisements so that hosts autoconfigure their addresses.',
  helpText: USAGE,
  complete: makeArgCompleter({
    flags: ['-C', '-c', '-d', '-f', '-h', '-l', '-m', '-n', '-p', '-t', '-u', '-v',
      '--config', '--configtest', '--debug', '--facility', '--help', '--logfile', '--logmethod', '--nodaemon',
      '--pidfile', '--chrootdir', '--username', '--version'],
  }),
  run(ctx: LinuxCommandContext, args: string[]): string {
    return run(ctx, args).output;
  },
  runWithStatusSync(ctx: LinuxCommandContext, args: string[]): { output: string; exitCode: number } {
    return run(ctx, args);
  },
};
